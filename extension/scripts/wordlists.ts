/**
 * Builds the stand-in word lists from Faker's locale definitions (see
 * src/core/surrogate/words/format.ts for the file format). Pure: the same
 * definitions always give the same files, byte for byte, so a test can
 * re-derive the committed files from the installed Faker version.
 *
 * Each locale takes a field from its own definitions, else from its parent
 * language (en_GB from en, es_MX from es), as Faker itself does; the report
 * lists every inherited and every missing field. Nothing is added that the
 * definitions do not contain, except the German street types, which Faker
 * has only inside full street names: they are listed below and each is kept
 * only if Faker's German street names use it.
 */
import { LOCALES, NAME_INDEX } from '../src/core/surrogate/words/locales.ts';
import type { ExtractedLocale } from './opendata/extracted.ts';
import {
  NAME_SEPARATOR,
  WORDLIST_VERSION,
  type LocaleWords,
  type StreetTypeOrder,
} from '../src/core/surrogate/words/format.ts';

export interface BuiltFile {
  readonly name: string;
  readonly contents: string;
}

export interface LocaleReport {
  readonly locale: string;
  readonly bytes: number;
  readonly counts: Readonly<Record<string, number>>;
  /** Field → the locale it came from (when not the locale itself). */
  readonly inherited: Readonly<Record<string, string>>;
  readonly missing: readonly string[];
}

export interface WordListBuild {
  readonly files: readonly BuiltFile[];
  readonly locales: readonly LocaleReport[];
  readonly indexBytes: number;
}

/** German street types, glued to the name (Ahornweg, Adalbertstr.). */
const GERMAN_STREET_TYPES = [
  'straße',
  'str.',
  'weg',
  'gasse',
  'platz',
  'allee',
  'ring',
  'damm',
  'ufer',
  'pfad',
];

type Definitions = Readonly<Record<string, unknown>>;

function field(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null && key in value
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

function pathOf(value: unknown, path: readonly string[]): unknown {
  let current = value;
  for (const key of path) current = field(current, key);
  return current;
}

function stringList(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}

/** NFC, trimmed, unique, in code-unit order. */
function tidy(values: Iterable<string>): string[] {
  const out = new Set<string>();
  for (const value of values) {
    const clean = value.normalize('NFC').trim();
    if (clean !== '') out.add(clean);
  }
  return [...out].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** A single word (names with spaces would change a name's part count). */
const NAME_WORD = /^[\p{L}\p{M}'’.-]+$/u;

function names(values: Iterable<string>): string[] {
  return tidy(values).filter((value) => NAME_WORD.test(value));
}

/** The locale's own definitions, then its parent language's. */
function chainOf(definitions: Definitions, id: string): string[] {
  const chain = [id];
  const language = id.split('_')[0];
  if (language !== undefined && language !== id && language in definitions) {
    chain.push(language);
  }
  return chain;
}

interface Lookup {
  value: unknown;
  from: string | null;
}

function lookup(
  definitions: Definitions,
  chain: readonly string[],
  path: readonly string[],
): Lookup {
  for (const id of chain) {
    const value = pathOf(definitions[id], path);
    if (value !== undefined && value !== null) return { value, from: id };
  }
  return { value: undefined, from: null };
}

/** Name lists by gender: a bare list counts as generic. */
function byGender(value: unknown): {
  generic: string[];
  female: string[];
  male: string[];
} {
  if (Array.isArray(value)) {
    return { generic: stringList(value), female: [], male: [] };
  }
  return {
    generic: stringList(field(value, 'generic')),
    female: stringList(field(value, 'female')),
    male: stringList(field(value, 'male')),
  };
}

const TYPE_PLACEHOLDER = /\{\{location\.(street_suffix|street_prefix)\}\}/u;

/**
 * The street types and their position, from the first street pattern that
 * uses one: first in the pattern → before the name; right after another
 * placeholder → glued; else after.
 */
function streetTypes(
  definitions: Definitions,
  chain: readonly string[],
): { types: string[]; order: StreetTypeOrder; from: string | null } {
  const patterns = lookup(definitions, chain, ['location', 'street_pattern']);
  for (const pattern of stringList(patterns.value)) {
    const match = TYPE_PLACEHOLDER.exec(pattern);
    const list = match?.[1];
    if (match === null || list === undefined) continue;
    const types = lookup(definitions, chain, ['location', list]);
    const order: StreetTypeOrder =
      match.index === 0
        ? 'before'
        : pattern.charAt(match.index - 1) === '}'
          ? 'glued'
          : 'after';
    return { types: tidy(stringList(types.value)), order, from: types.from };
  }
  return { types: [], order: 'after', from: null };
}

/**
 * Turkish street types, which Faker has only inside full street names
 * ("Atatürk Bulvarı", "Kocatepe Caddesi", "Fatih Sokak"): the last word of
 * the names, kept when at least two names end with it; written after the
 * name.
 */
function turkishStreetTypes(
  definitions: Definitions,
  chain: readonly string[],
): { types: string[]; order: StreetTypeOrder } {
  const counts = new Map<string, number>();
  for (const name of stringList(
    lookup(definitions, chain, ['location', 'street_name']).value,
  )) {
    const last = name.trim().split(/\s+/u).at(-1) ?? '';
    if (/^\p{L}+$/u.test(last)) counts.set(last, (counts.get(last) ?? 0) + 1);
  }
  return {
    types: tidy(
      [...counts].filter(([, count]) => count >= 2).map(([type]) => type),
    ),
    order: 'after',
  };
}

/** Product of the per-position character sets of equal-length patterns. */
function positionSets(patterns: readonly string[]): Set<string>[] {
  const sets: Set<string>[] = [];
  for (const pattern of patterns) {
    Array.from(pattern).forEach((char, position) => {
      (sets[position] ??= new Set()).add(char);
    });
  }
  return sets;
}

function template(sets: readonly Set<string>[]): string {
  return sets
    .map((set) => {
      const chars = [...set].sort();
      return chars.length === 1 ? (chars[0] ?? '') : `[${chars.join('')}]`;
    })
    .join('');
}

/**
 * Faker lists some postcode formats in full (every Canadian letter
 * combination); groups that are exactly a product of per-position
 * character choices become one template. A position mixing Faker's symbols
 * (# and ?) with other characters is never merged.
 */
function compressPostcodes(patterns: readonly string[]): string[] {
  const out: string[] = [];
  const compress = (group: readonly string[]): void => {
    const sets = positionSets(group);
    const product = sets.reduce((total, set) => total * set.size, 1);
    const mixed = sets.some(
      (set) => set.size > 1 && (set.has('#') || set.has('?')),
    );
    if (group.length === 1 || (!mixed && product === group.length)) {
      out.push(template(sets));
      return;
    }
    const position = sets.findIndex((set) => set.size > 1);
    const parts = new Map<string, string[]>();
    for (const pattern of group) {
      const key = Array.from(pattern)[position] ?? '';
      parts.set(key, [...(parts.get(key) ?? []), pattern]);
    }
    for (const key of [...parts.keys()].sort()) compress(parts.get(key) ?? []);
  };
  const byLength = new Map<number, string[]>();
  for (const pattern of tidy(patterns)) {
    const length = Array.from(pattern).length;
    byLength.set(length, [...(byLength.get(length) ?? []), pattern]);
  }
  for (const length of [...byLength.keys()].sort((a, b) => a - b)) {
    compress(byLength.get(length) ?? []);
  }
  return tidy(out);
}

const difference = (a: readonly string[], b: ReadonlySet<string>) =>
  a.filter((value) => !b.has(value));

function fold(value: string): string {
  return value.normalize('NFD').replace(/\p{M}/gu, '').normalize('NFC');
}

/** Names grouped by their flags: "female,male,neutral,family" → names. */
function groupsOf(
  index: ReadonlyMap<string, readonly number[]>,
): Map<string, string> {
  const groups = new Map<string, string[]>();
  for (const [name, flags] of index) {
    if (name.includes(NAME_SEPARATOR)) {
      throw new Error(`name with a separator: ${name}`);
    }
    const key = flags.join(',');
    groups.set(key, [...(groups.get(key) ?? []), name]);
  }
  return new Map(
    [...groups].map(([key, names]) => [key, tidy(names).join(NAME_SEPARATOR)]),
  );
}

export function buildWordLists(
  definitions: Definitions,
  extracted: readonly ExtractedLocale[] = [],
): WordListBuild {
  const files: BuiltFile[] = [];
  const reports: LocaleReport[] = [];
  const index = new Map<string, [number, number, number, number]>();
  const legalIndex = new Map<string, number>();

  const mark = (name: string, slot: number, bit: number): void => {
    for (const key of new Set([name.toLowerCase(), fold(name.toLowerCase())])) {
      const flags = index.get(key) ?? [0, 0, 0, 0];
      flags[slot] = (flags[slot] ?? 0) | bit;
      index.set(key, flags);
    }
  };

  const extras = new Map(extracted.map((entry) => [entry.locale, entry]));
  for (const [position, info] of LOCALES.entries()) {
    const { id } = info;
    if (info.faker !== null && !(info.faker in definitions)) {
      throw new Error(`Faker has no locale ${info.faker}`);
    }
    const chain = info.faker === null ? [] : chainOf(definitions, info.faker);
    const extra = extras.get(id);
    const inherited: Record<string, string> = {};
    const missing: string[] = [];
    /**
     * Records where a field came from: Faker's own definitions, its parent
     * language's, or the open data (replacing an inherited or missing list,
     * or added to the locale's own).
     */
    const note = (
      name: string,
      from: string | null,
      empty: boolean,
      open: 'none' | 'replaced' | 'added' = 'none',
    ) => {
      if (open === 'replaced') inherited[name] = 'open data';
      else if (open === 'added') inherited[name] = `${id} + open data`;
      else if (from === null || empty) missing.push(name);
      else if (from !== info.faker) inherited[name] = from;
    };
    /** The open data replaces lists Faker only inherits, adds to its own. */
    const openMode = (from: string | null, present: boolean) =>
      !present
        ? 'none'
        : info.faker !== null && from === info.faker
          ? 'added'
          : 'replaced';

    const first = lookup(definitions, chain, ['person', 'first_name']);
    const fakerGiven = byGender(first.value);
    const givenMode = openMode(first.from, extra?.given !== undefined);
    const keepFaker = givenMode !== 'replaced';
    const female = new Set(
      names([
        ...(keepFaker ? fakerGiven.female : []),
        ...(extra?.given?.female ?? []),
      ]),
    );
    const male = new Set(
      names([
        ...(keepFaker ? fakerGiven.male : []),
        ...(extra?.given?.male ?? []),
      ]),
    );
    const generic = names([
      ...(keepFaker ? fakerGiven.generic : []),
      ...(extra?.given?.neutral ?? []),
    ]);
    const both = [...female].filter((name) => male.has(name));
    const neutral = tidy([
      ...both,
      ...generic.filter((name) => !female.has(name) && !male.has(name)),
    ]);
    const bothSet = new Set(both);
    note(
      'given names',
      first.from,
      female.size + male.size + neutral.length === 0,
      givenMode,
    );

    const last = lookup(definitions, chain, ['person', 'last_name']);
    const family = byGender(last.value);
    const familyMode = openMode(last.from, extra?.family !== undefined);
    const familyAny = names([
      ...(familyMode === 'replaced' ? [] : family.generic),
      ...(extra?.family ?? []),
    ]);
    const familyFemale = familyMode === 'replaced' ? [] : names(family.female);
    const familyMale = familyMode === 'replaced' ? [] : names(family.male);
    note(
      'family names',
      last.from,
      familyAny.length + familyFemale.length + familyMale.length === 0,
      familyMode,
    );

    const legalLookup = lookup(definitions, chain, [
      'company',
      'legal_entity_type',
    ]);
    const legalMode = openMode(legalLookup.from, extra?.legal !== undefined);
    const legal = tidy([
      ...(legalMode === 'replaced' ? [] : stringList(legalLookup.value)),
      ...(extra?.legal ?? []),
    ]);
    note('legal suffixes', legalLookup.from, legal.length === 0, legalMode);

    let street = streetTypes(definitions, chain);
    if (id === 'de' && street.types.length === 0) {
      const streetNames = stringList(
        lookup(definitions, chain, ['location', 'street_name']).value,
      ).map((name) => name.toLowerCase());
      street = {
        types: GERMAN_STREET_TYPES.filter((type) =>
          streetNames.some((name) => name.endsWith(type)),
        ),
        order: 'glued',
        from: id,
      };
    }
    if (id === 'tr' && street.types.length === 0) {
      street = { ...turkishStreetTypes(definitions, chain), from: id };
    }
    let streetMode: 'none' | 'replaced' | 'added' = 'none';
    const extraOrder = extra?.streetTypeOrder ?? 'after';
    if (extra?.streetTypes !== undefined) {
      if (street.types.length === 0) {
        street = {
          types: tidy(extra.streetTypes),
          order: extraOrder,
          from: null,
        };
        streetMode = 'replaced';
      } else if (street.order === extraOrder) {
        // Written the same way: the open data's types join Faker's.
        street = {
          ...street,
          types: tidy([...street.types, ...extra.streetTypes]),
        };
        streetMode = 'added';
      }
    }
    note('street types', street.from, street.types.length === 0, streetMode);

    const streets = names(extra?.streets ?? []);
    if (extra?.streets !== undefined)
      note('street names', null, false, 'replaced');

    const cities = lookup(definitions, chain, ['location', 'city_name']);
    const cityMode = openMode(cities.from, extra?.localities !== undefined);
    const localities = tidy([
      ...(cityMode === 'replaced' ? [] : stringList(cities.value)),
      ...(extra?.localities ?? []),
    ]);
    note('localities', cities.from, localities.length === 0, cityMode);

    const postcodeLookup = lookup(definitions, chain, ['location', 'postcode']);
    const postcodes = compressPostcodes(stringList(postcodeLookup.value));
    note('postcodes', postcodeLookup.from, postcodes.length === 0);

    const words: LocaleWords = {
      version: WORDLIST_VERSION,
      locale: id,
      given: {
        female: difference([...female], bothSet),
        male: difference([...male], bothSet),
        neutral,
      },
      family: { any: familyAny, female: familyFemale, male: familyMale },
      legal,
      streetTypes: street.types,
      streetTypeOrder: street.order,
      streets,
      localities,
      postcodes,
    };
    const contents = JSON.stringify(words);
    files.push({ name: `${id}.json`, contents });

    const bit = 2 ** position;
    for (const name of words.given.female) mark(name, 0, bit);
    for (const name of words.given.male) mark(name, 1, bit);
    for (const name of neutral) mark(name, 2, bit);
    for (const name of [...familyAny, ...familyFemale, ...familyMale]) {
      mark(name, 3, bit);
    }
    for (const suffix of legal) {
      legalIndex.set(suffix, (legalIndex.get(suffix) ?? 0) | bit);
    }

    reports.push({
      locale: id,
      bytes: Buffer.byteLength(contents),
      counts: {
        female: words.given.female.length,
        male: words.given.male.length,
        neutral: neutral.length,
        family: familyAny.length + familyFemale.length + familyMale.length,
        legal: legal.length,
        streetTypes: street.types.length,
        streets: streets.length,
        localities: localities.length,
        postcodes: postcodes.length,
      },
      inherited,
      missing,
    });
  }

  const sortedKeys = <T>(map: ReadonlyMap<string, T>): [string, T][] =>
    [...map.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const indexContents = JSON.stringify({
    version: WORDLIST_VERSION,
    locales: LOCALES.map((locale) => locale.id),
    groups: Object.fromEntries(sortedKeys(groupsOf(index))),
    legal: Object.fromEntries(sortedKeys(legalIndex)),
  });
  files.push({ name: `${NAME_INDEX}.json`, contents: indexContents });

  return {
    files,
    locales: reports,
    indexBytes: Buffer.byteLength(indexContents),
  };
}
