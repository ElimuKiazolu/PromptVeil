/**
 * Builds the extracted word lists (opendata/extracted/<locale>.json) from the
 * raw open-data files (npm run opendata:fetch first) and records their
 * checksums in opendata/sources.json. Deterministic: the same raw files give
 * the same output, byte for byte.
 *
 *   npm run opendata:extract
 *
 * Selection (most frequent or most populous first where the data has
 * counts, then capped; the lists are stored sorted, as all word lists are):
 * - en_GB: given names from ONS baby names (total count 1996-2025), family
 *   names of British people on Wikidata, localities and street names from
 *   OS Open Names.
 * - pt_BR: given and family names of Brazilian people on Wikidata, localities
 *   from GeoNames (by population), street types from Wikidata's Brazilian
 *   street names.
 * - en_SG: family names of Singaporean people, given names of Singaporean
 *   people and of Malay and Tamil speakers (Wikidata), localities from
 *   GeoNames, street names and types from URA's road names, legal forms of
 *   Singaporean organisations (Wikidata).
 * - zh_Latn: Faker's Chinese names in Hanyu Pinyin (Unihan kMandarin), only
 *   names whose characters have a single reading.
 * - nl, sv, ja: localities from GeoNames (by population; ja in Japanese).
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { allLocales } from '@faker-js/faker';
import { EXTRACTED, rawFile, readSources, writeSources } from './sources.ts';
import type { ExtractedLocale } from './extracted.ts';
import { readXlsx } from './xlsx.ts';
import { readZip, zipEntry } from './zip.ts';

const CAPS = {
  givenPerGender: 500,
  family: 800,
  brazilFamily: 500,
  localities: 800,
  ukLocalities: 2500,
  streets: 800,
  singaporeFamily: 300,
  singaporeGiven: 600,
};

const sorted = (values: Iterable<string>): string[] =>
  [...new Set(values)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

/** The `limit` keys with the highest counts (ties by name). */
function top(counts: ReadonlyMap<string, number>, limit: number): string[] {
  return [...counts]
    .sort(([a, x], [b, y]) => y - x || (a < b ? -1 : a > b ? 1 : 0))
    .slice(0, limit)
    .map(([name]) => name);
}

function add(counts: Map<string, number>, key: string, by: number): void {
  counts.set(key, (counts.get(key) ?? 0) + by);
}

// ---- ONS baby names ----

/** Names written as one word of letters (with ' or -), in title case. */
const TITLE_WORD = /^\p{Lu}[\p{Ll}\p{M}]*(?:['’-]\p{Lu}?[\p{Ll}\p{M}]+)*$/u;

function onsGiven(): { female: string[]; male: string[] } {
  const sheets = readXlsx(
    readFileSync(rawFile('ons-baby-names', 'babynames1996to2025.xlsx')),
  );
  const totals = (sheetName: string): Map<string, number> => {
    const sheet = sheets.find((candidate) => candidate.name === sheetName);
    if (sheet === undefined) throw new Error(`no ${sheetName}`);
    const header = sheet.rows.findIndex((row) => row[0] === 'Name');
    const counts = new Map<string, number>();
    const columns = (sheet.rows[header] ?? []).flatMap((title, index) =>
      title.endsWith(' Count') ? [index] : [],
    );
    for (const row of sheet.rows.slice(header + 1)) {
      const name = row[0] ?? '';
      if (!TITLE_WORD.test(name) || name.length < 2) continue;
      for (const column of columns) {
        const count = Number(row[column]);
        if (Number.isFinite(count)) add(counts, name, count);
      }
    }
    return counts;
  };
  return {
    female: top(totals('Table_1'), CAPS.givenPerGender),
    male: top(totals('Table_2'), CAPS.givenPerGender),
  };
}

// ---- Wikidata ----

interface WikidataName {
  label: string;
  family: boolean;
  female: boolean;
  male: boolean;
  count: number;
}

const FEMALE_GIVEN = 'Q11879590';
const MALE_GIVEN = 'Q12308941';
const UNISEX_GIVEN = 'Q3409032';
const FAMILY_NAME = 'Q101352';

interface Bindings {
  results: {
    bindings: Record<string, { value: string; 'xml:lang'?: string }>[];
  };
}

const readJson = (file: string): Bindings =>
  JSON.parse(readFileSync(file, 'utf8')) as Bindings;

const idOf = (uri: string): string => uri.split('/').pop() ?? '';

/** A count query's name items with their labels (mul, en, pt) and kinds. */
function wikidataNames(name: string): WikidataName[] {
  const counts = readJson(rawFile('wikidata', `${name}.json`));
  const labels = readJson(rawFile('wikidata', `${name}.labels.json`));
  const info = new Map<
    string,
    { labels: Map<string, string>; kinds: Set<string> }
  >();
  for (const row of labels.results.bindings) {
    const id = idOf(row.name?.value ?? '');
    const entry = info.get(id) ?? { labels: new Map(), kinds: new Set() };
    if (row.label !== undefined && row.lang !== undefined) {
      entry.labels.set(row.lang.value, row.label.value);
    }
    if (row.kind !== undefined) entry.kinds.add(idOf(row.kind.value));
    info.set(id, entry);
  }
  return counts.results.bindings.flatMap((row) => {
    const entry = info.get(idOf(row.name?.value ?? ''));
    const label =
      entry?.labels.get('mul') ??
      entry?.labels.get('en') ??
      entry?.labels.get('pt');
    if (entry === undefined || label === undefined) return [];
    const unisex = entry.kinds.has(UNISEX_GIVEN);
    return [
      {
        label: label.normalize('NFC'),
        family: entry.kinds.has(FAMILY_NAME),
        female: unisex || entry.kinds.has(FEMALE_GIVEN),
        male: unisex || entry.kinds.has(MALE_GIVEN),
        count: Number(row.n?.value ?? 0),
      },
    ];
  });
}

function familyNames(
  names: readonly WikidataName[],
  word: RegExp,
  minimum: number,
  limit: number,
): string[] {
  const counts = new Map<string, number>();
  for (const name of names) {
    if (name.family && name.count >= minimum && word.test(name.label)) {
      add(counts, name.label, name.count);
    }
  }
  return top(counts, limit);
}

function givenNames(
  lists: readonly (readonly WikidataName[])[],
  word: RegExp,
  minimum: number,
  limit: number,
): { female: string[]; male: string[]; neutral: string[] } {
  const counts = new Map<string, number>();
  const gender = new Map<string, { female: boolean; male: boolean }>();
  for (const names of lists) {
    for (const name of names) {
      if (!(name.female || name.male) || !word.test(name.label)) continue;
      add(counts, name.label, name.count);
      const known = gender.get(name.label) ?? { female: false, male: false };
      gender.set(name.label, {
        female: known.female || name.female,
        male: known.male || name.male,
      });
    }
  }
  for (const [label, count] of counts)
    if (count < minimum) counts.delete(label);
  const chosen = top(counts, limit);
  const of = (label: string) =>
    gender.get(label) ?? { female: false, male: false };
  return {
    female: sorted(chosen.filter((l) => of(l).female && !of(l).male)),
    male: sorted(chosen.filter((l) => of(l).male && !of(l).female)),
    neutral: sorted(chosen.filter((l) => of(l).male && of(l).female)),
  };
}

/** Plain ASCII names (Singapore's romanised names). */
const ASCII_WORD = /^[A-Z][a-z]+(?:['-][A-Z]?[a-z]+)?$/u;

// ---- GeoNames ----

interface Place {
  name: string;
  alternates: string[];
  featureClass: string;
  featureCode: string;
  country: string;
  population: number;
  id: number;
}

function geonames(zip: string, member: string): Place[] {
  const text = zipEntry(readZip(readFileSync(rawFile('geonames', zip))), member)
    .read()
    .toString('utf8');
  return text.split('\n').flatMap((line) => {
    const cells = line.split('\t');
    if (cells.length < 15) return [];
    return [
      {
        id: Number(cells[0]),
        name: (cells[1] ?? '').normalize('NFC'),
        alternates: (cells[3] ?? '').split(',').filter((name) => name !== ''),
        featureClass: cells[6] ?? '',
        featureCode: cells[7] ?? '',
        country: cells[8] ?? '',
        population: Number(cells[14] ?? 0),
      },
    ];
  });
}

const byPopulation = (a: Place, b: Place): number =>
  b.population - a.population || a.id - b.id;

/** A place name without digits, brackets or commas. */
const PLACE = /^[\p{L}\p{M}][\p{L}\p{M}'’. -]*[\p{L}\p{M}.]$/u;
/** Japanese municipalities: city, town, village or ward. */
const JAPANESE_PLACE =
  /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}ー]+[市町村区]$/u;

function localities(
  places: readonly Place[],
  country: string,
  nameOf: (place: Place) => string | null,
  limit: number,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const place of [...places].sort(byPopulation)) {
    if (place.country !== country || place.featureClass !== 'P') continue;
    const name = nameOf(place);
    if (name === null || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
    if (out.length === limit) break;
  }
  return sorted(out);
}

// ---- OS Open Names ----

const BYTE_ORDER_MARK = new RegExp(`^${String.fromCharCode(0xfeff)}`, 'u');

/** Street types stripped from UK and Singapore road names (and kept). */
const ENGLISH_STREET_TYPES = new Set(
  (allLocales.en.location?.street_suffix ?? []).map((type) =>
    type.toLowerCase(),
  ),
);
for (const type of [
  'road',
  'street',
  'lane',
  'avenue',
  'close',
  'drive',
  'way',
  'gardens',
  'crescent',
  'place',
  'court',
  'grove',
  'terrace',
  'hill',
  'row',
  'walk',
  'square',
  'mews',
  'rise',
  'vale',
  'view',
  'park',
  'link',
  'green',
  'end',
]) {
  ENGLISH_STREET_TYPES.add(type);
}

/** Words that are not a street's own name (a type or a direction). */
const NOT_A_STEM = new Set([
  ...ENGLISH_STREET_TYPES,
  'north',
  'south',
  'east',
  'west',
  'upper',
  'lower',
  'old',
  'new',
  'the',
]);
const isStem = (word: string): boolean =>
  word.length >= 3 && !NOT_A_STEM.has(word.toLowerCase());

interface OsNames {
  localities: string[];
  streets: string[];
}

function osOpenNames(): OsNames {
  const entries = readZip(
    readFileSync(rawFile('os-open-names', 'opname_csv_gb.zip')),
  );
  const header = zipEntry(entries, 'OS_Open_Names_Header.csv')
    .read()
    .toString('utf8')
    .replace(BYTE_ORDER_MARK, '')
    .trim()
    .split(',');
  const column = (name: string): number => {
    const index = header.indexOf(name);
    if (index < 0) throw new Error(`no ${name} column`);
    return index;
  };
  const NAME1 = column('NAME1');
  const TYPE = column('TYPE');
  const LOCAL_TYPE = column('LOCAL_TYPE');
  const RANK: Record<string, number> = {
    City: 0,
    Town: 1,
    'Suburban Area': 2,
    Village: 3,
  };
  const places = new Map<string, number>();
  const stems = new Map<string, number>();
  for (const entry of entries) {
    if (!/^Data\/[^/]+\.csv$/u.test(entry.name)) continue;
    for (const line of entry.read().toString('utf8').split('\n')) {
      // NAME1 and the type fields never hold commas inside quotes we use.
      const cells = line.split(',');
      const name = (cells[NAME1] ?? '').replace(/^"|"$/gu, '').normalize('NFC');
      const type = cells[TYPE] ?? '';
      const local = (cells[LOCAL_TYPE] ?? '').replace(/^"|"$/gu, '');
      if (type === 'populatedPlace' && local in RANK && PLACE.test(name)) {
        const rank = RANK[local] ?? 9;
        places.set(name, Math.min(places.get(name) ?? 9, rank));
      } else if (type === 'transportNetwork' && local === 'Named Road') {
        const words = name.split(' ');
        const last = words.at(-1)?.toLowerCase() ?? '';
        if (words.length === 2 && ENGLISH_STREET_TYPES.has(last)) {
          const stem = words[0] ?? '';
          if (TITLE_WORD.test(stem) && isStem(stem)) add(stems, stem, 1);
        }
      }
    }
  }
  const chosen = [...places]
    .sort(([a, x], [b, y]) => x - y || (a < b ? -1 : a > b ? 1 : 0))
    .slice(0, CAPS.ukLocalities)
    .map(([name]) => name);
  return {
    localities: sorted(chosen),
    streets: sorted(top(stems, CAPS.streets)),
  };
}

// ---- URA road names (Singapore) ----

function singaporeStreets(): {
  streets: string[];
  streetTypes: string[];
} {
  const data = JSON.parse(
    readFileSync(rawFile('ura-road-names', 'ura-road-names.geojson'), 'utf8'),
  ) as { features: { properties: Record<string, unknown> }[] };
  const types = new Map<string, number>();
  const stems = new Map<string, number>();
  for (const feature of data.features) {
    const raw = feature.properties.TEXTSTRING;
    if (typeof raw !== 'string') continue;
    // Written in capitals: "SERANGOON ROAD", "ANG MO KIO AVENUE 3".
    const words = raw
      .trim()
      .split(/\s+/u)
      .filter((word) => !/\d/u.test(word))
      .map((word) => word.charAt(0) + word.slice(1).toLowerCase());
    const last = words.at(-1);
    if (last === undefined || words.length !== 2) continue;
    if (ENGLISH_STREET_TYPES.has(last.toLowerCase())) {
      add(types, last, 1);
      const stem = words[0] ?? '';
      if (ASCII_WORD.test(stem) && isStem(stem)) add(stems, stem, 1);
    }
  }
  for (const [type, count] of types) if (count < 3) types.delete(type);
  return {
    streets: sorted(top(stems, CAPS.streets)),
    streetTypes: sorted(types.keys()),
  };
}

// ---- Unihan (pinyin) ----

/**
 * Each character's modern Mandarin readings (kMandarin, kXHC1983,
 * kTGHZ2013), without tones, the customary one first.
 */
function unihanReadings(): Map<string, string[]> {
  const entries = readZip(readFileSync(rawFile('unihan', 'Unihan.zip')));
  const text = zipEntry(entries, 'Unihan_Readings.txt').read().toString('utf8');
  const plain = (syllable: string): string =>
    syllable.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
  const readings = new Map<string, string[]>();
  const note = (char: string, syllables: Iterable<string>): void => {
    const list = readings.get(char) ?? [];
    for (const syllable of syllables) {
      const value = plain(syllable);
      if (/^[a-z]+$/u.test(value) && !list.includes(value)) list.push(value);
    }
    readings.set(char, list);
  };
  for (const line of text.split('\n')) {
    const [code, field, value] = line.split('\t');
    if (code === undefined || value === undefined || !code.startsWith('U+')) {
      continue;
    }
    const char = String.fromCodePoint(Number.parseInt(code.slice(2), 16));
    if (field === 'kMandarin') {
      // Customary reading first.
      const list = readings.get(char) ?? [];
      readings.set(char, []);
      note(char, value.split(' '));
      note(char, list);
    } else if (field === 'kXHC1983' || field === 'kTGHZ2013') {
      // Modern dictionaries' readings (kHanyuPinyin adds historical ones).
      note(
        char,
        value
          .split(' ')
          .flatMap((part) => (part.split(':')[1] ?? '').split(',')),
      );
    }
  }
  return readings;
}

/** A Chinese name in pinyin, or null when a character has several readings. */
function pinyin(
  name: string,
  readings: ReadonlyMap<string, string[]>,
): string | null {
  let out = '';
  for (const char of name) {
    const list = readings.get(char);
    if (list?.length !== 1) return null;
    out += list[0] ?? '';
  }
  return out === '' ? null : out.charAt(0).toUpperCase() + out.slice(1);
}

function fakerList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === 'string');
  }
  if (typeof value === 'object' && value !== null) {
    return Object.values(value).flatMap(fakerList);
  }
  return [];
}

function romanisedChinese(): ExtractedLocale {
  const readings = unihanReadings();
  const person = allLocales.zh_CN.person;
  const convert = (names: unknown): string[] =>
    sorted(fakerList(names).flatMap((name) => pinyin(name, readings) ?? []));
  const given = person?.first_name;
  const byGender = (key: string): unknown =>
    typeof given === 'object' && given !== null && !Array.isArray(given)
      ? (given as Record<string, unknown>)[key]
      : undefined;
  const female = convert(byGender('female'));
  const male = convert(byGender('male'));
  const generic = convert(Array.isArray(given) ? given : byGender('generic'));
  return {
    locale: 'zh_Latn',
    sources: ['unihan'],
    given: {
      female: female.filter((name) => !male.includes(name)),
      male: male.filter((name) => !female.includes(name)),
      neutral: sorted([
        ...generic.filter(
          (name) => !female.includes(name) && !male.includes(name),
        ),
        ...female.filter((name) => male.includes(name)),
      ]),
    },
    family: convert(person?.last_name),
  };
}

// ---- assemble ----

function extract(): ExtractedLocale[] {
  const os = osOpenNames();
  const ons = onsGiven();
  const cities = geonames('cities1000.zip', 'cities1000.txt');
  const singapore = geonames('SG.zip', 'SG.txt');
  const plainName = (place: Place): string | null =>
    PLACE.test(place.name) ? place.name : null;

  const ura = singaporeStreets();
  const singaporeLegal = readJson(rawFile('wikidata', 'legal-sg.json'))
    .results.bindings.filter(
      (row) =>
        Number(row.n?.value ?? 0) >= 3 &&
        (row.short?.['xml:lang'] ?? '').startsWith('en'),
    )
    .map((row) => row.short?.value ?? '');

  const streetsBr = readJson(rawFile('wikidata', 'streets-br.json')).results
    .bindings;
  const brTypes = new Map<string, number>();
  for (const row of streetsBr) {
    const first = (row.label?.value ?? '').split(' ')[0] ?? '';
    if (TITLE_WORD.test(first)) add(brTypes, first, 1);
  }
  // A type is a first word many streets share (Rua, Avenida, Travessa…).
  const brStreetTypes = sorted(
    [...brTypes].filter(([, count]) => count >= 2).map(([type]) => type),
  );

  return [
    {
      locale: 'en_GB',
      sources: ['ons-baby-names', 'wikidata', 'os-open-names'],
      given: {
        female: sorted(ons.female),
        male: sorted(ons.male),
        neutral: [],
      },
      family: sorted(
        familyNames(wikidataNames('family-gb'), TITLE_WORD, 3, CAPS.family),
      ),
      localities: os.localities,
      streets: os.streets,
    },
    {
      locale: 'pt_BR',
      sources: ['wikidata', 'geonames'],
      given: givenNames(
        [wikidataNames('given-br')],
        TITLE_WORD,
        2,
        CAPS.family,
      ),
      family: sorted(
        familyNames(
          wikidataNames('family-br'),
          TITLE_WORD,
          2,
          CAPS.brazilFamily,
        ),
      ),
      localities: localities(cities, 'BR', plainName, CAPS.localities),
      streetTypes: brStreetTypes,
      streetTypeOrder: 'before',
    },
    {
      locale: 'en_SG',
      sources: ['wikidata', 'geonames', 'ura-road-names'],
      given: givenNames(
        ['given-sg', 'given-malay', 'given-tamil'].map(wikidataNames),
        ASCII_WORD,
        2,
        CAPS.singaporeGiven,
      ),
      family: sorted(
        familyNames(
          wikidataNames('family-sg'),
          ASCII_WORD,
          2,
          CAPS.singaporeFamily,
        ),
      ),
      legal: sorted(singaporeLegal),
      localities: sorted(
        singapore
          .filter(
            (place) =>
              place.featureClass === 'P' ||
              (place.featureClass === 'A' && place.featureCode !== 'PCLI'),
          )
          .sort(byPopulation)
          .flatMap((place) => plainName(place) ?? [])
          .filter((name) => name !== 'Singapore')
          .slice(0, 300),
      ),
      streets: ura.streets,
      streetTypes: ura.streetTypes,
      streetTypeOrder: 'after',
    },
    romanisedChinese(),
    {
      locale: 'nl',
      sources: ['geonames'],
      localities: localities(cities, 'NL', plainName, CAPS.localities),
    },
    {
      locale: 'sv',
      sources: ['geonames'],
      localities: localities(cities, 'SE', plainName, CAPS.localities),
    },
    {
      locale: 'ja',
      sources: ['geonames'],
      localities: localities(
        cities,
        'JP',
        (place) =>
          place.alternates.find((name) => JAPANESE_PLACE.test(name)) ?? null,
        CAPS.localities,
      ),
    },
  ];
}

const sources = readSources();
mkdirSync(EXTRACTED, { recursive: true });
const checksums: Record<string, string> = {};
for (const locale of extract()) {
  const name = `${locale.locale}.json`;
  const contents = `${JSON.stringify(locale)}\n`;
  writeFileSync(join(EXTRACTED, name), contents);
  checksums[name] = createHash('sha256').update(contents).digest('hex');
  const counts = Object.entries(locale as unknown as Record<string, unknown>)
    .filter(([key]) => key !== 'locale' && key !== 'sources')
    .map(([key, value]) =>
      Array.isArray(value)
        ? `${key} ${value.length.toString()}`
        : typeof value === 'object' && value !== null
          ? `${key} ${Object.values(value)
              .map((list: unknown) => (Array.isArray(list) ? list.length : 0))
              .join('/')}`
          : `${key} ${String(value)}`,
    )
    .join(', ');
  console.log(
    `${locale.locale.padEnd(8)} ${(Buffer.byteLength(contents) / 1024).toFixed(1).padStart(6)} kB  ${counts}`,
  );
}
sources.extracted = checksums;
writeSources(sources);
