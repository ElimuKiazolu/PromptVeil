/**
 * ADDRESS stand-ins (TR-S2): house and flat numbers, the street's name,
 * the localities between street and city, and the postcode are replaced in
 * the same country's format; the street type (Road, Rue, -straße), the
 * city and the country stay (the city too is replaced when
 * settings.keepCity is off). Punctuation and line breaks stay as written.
 *
 * The country comes from a country name at the end, else from the postcode
 * format of the request's country, the home regions or any known format,
 * in that order. Lines are split at commas and line breaks: the first line
 * with a number or a street type is the street; the line with the postcode
 * holds the city (or, when it holds only a state code, the line before it
 * does); the lines between are localities.
 *
 * Addresses in CJK scripts are written without such separators: there the
 * digits are replaced, and the road name before a road word (路, 街, 로, 길…)
 * gets a family name in its place.
 */
import type { CountryCode } from '../../shared/country.ts';
import { CJK, inCaseOf } from '../names/parts.ts';
import { DIGITS, LOWER, UPPER, type Rng } from './rng.ts';
import type { LocaleWords } from './words/format.ts';
import {
  DEFAULT_LOCALE,
  localeForRegion,
  scriptOf,
  type LocaleId,
} from './words/locales.ts';
import { familyNames, givenNames, pickWord, wordsOf } from './words/pick.ts';
import type { Generator, StandInEnvironment } from './types.ts';

/** Postcode formats by country. */
const FORMATS: Readonly<Partial<Record<CountryCode, { postcode: RegExp }>>> = {
  GB: { postcode: /\b[A-Z]{1,2}\d[A-Z\d]? ?\d[A-Z]{2}\b/giu },
  US: { postcode: /\b\d{5}(?:-\d{4})?\b/gu },
  CA: { postcode: /\b[A-Z]\d[A-Z] ?\d[A-Z]\d\b/giu },
  AU: { postcode: /\b\d{4}\b/gu },
  NZ: { postcode: /\b\d{4}\b/gu },
  IN: { postcode: /\b\d{3} ?\d{3}\b/gu },
  ZA: { postcode: /\b\d{4}\b/gu },
  NG: { postcode: /\b\d{6}\b/gu },
  FR: { postcode: /\b\d{5}\b/gu },
  DE: { postcode: /\b\d{5}\b/gu },
  AT: { postcode: /\b\d{4}\b/gu },
  IT: { postcode: /\b\d{5}\b/gu },
  ES: { postcode: /\b\d{5}\b/gu },
  MX: { postcode: /\b\d{5}\b/gu },
  BR: { postcode: /\b\d{5}-?\d{3}\b/gu },
  NL: { postcode: /\b\d{4} ?[A-Z]{2}\b/gu },
  PL: { postcode: /\b\d{2}-\d{3}\b/gu },
  SE: { postcode: /\b\d{3} ?\d{2}\b/gu },
  TR: { postcode: /\b\d{5}\b/gu },
  ID: { postcode: /\b\d{5}\b/gu },
  RU: { postcode: /\b\d{6}\b/gu },
  CN: { postcode: /\b\d{6}\b/gu },
  JP: { postcode: /\d{3}-\d{4}/gu },
  KR: { postcode: /\b\d{5}\b/gu },
};

/** Country names as written at the end of an address (lower case). */
const COUNTRY_NAMES = new Map<string, CountryCode>([
  ['united kingdom', 'GB'],
  ['uk', 'GB'],
  ['great britain', 'GB'],
  ['england', 'GB'],
  ['scotland', 'GB'],
  ['wales', 'GB'],
  ['northern ireland', 'GB'],
  ['united states', 'US'],
  ['united states of america', 'US'],
  ['usa', 'US'],
  ['u.s.a.', 'US'],
  ['us', 'US'],
  ['canada', 'CA'],
  ['australia', 'AU'],
  ['new zealand', 'NZ'],
  ['india', 'IN'],
  ['south africa', 'ZA'],
  ['nigeria', 'NG'],
  ['france', 'FR'],
  ['germany', 'DE'],
  ['deutschland', 'DE'],
  ['austria', 'AT'],
  ['österreich', 'AT'],
  ['italy', 'IT'],
  ['italia', 'IT'],
  ['spain', 'ES'],
  ['españa', 'ES'],
  ['mexico', 'MX'],
  ['méxico', 'MX'],
  ['brazil', 'BR'],
  ['brasil', 'BR'],
  ['netherlands', 'NL'],
  ['the netherlands', 'NL'],
  ['nederland', 'NL'],
  ['poland', 'PL'],
  ['polska', 'PL'],
  ['sweden', 'SE'],
  ['sverige', 'SE'],
  ['turkey', 'TR'],
  ['türkiye', 'TR'],
  ['indonesia', 'ID'],
  ['russia', 'RU'],
  ['россия', 'RU'],
  ['china', 'CN'],
  ['中国', 'CN'],
  ['japan', 'JP'],
  ['日本', 'JP'],
  ['south korea', 'KR'],
  ['korea', 'KR'],
  ['대한민국', 'KR'],
]);

/** Street types beyond the word lists' (abbreviations, other languages). */
const STREET_TYPES = [
  'rd',
  'rd.',
  'st',
  'st.',
  'ave',
  'ave.',
  'blvd',
  'blvd.',
  'dr',
  'dr.',
  'ln',
  'ln.',
  'pkwy',
  'ct',
  'pl',
  'sq',
  'hwy',
  'marg',
  'nagar',
  'path',
  'cross',
  'main',
];

/** Words before a flat or unit number ("Flat 3", "Apt 4B"). */
const UNIT_WORDS =
  /^(?:flat|apt|apartment|unit|suite|ste|floor|fl|room|wohnung|whg|étage|appartement|piso|interno|int|lokal|m\.|kv\.?|кв\.?)$/iu;

/** Compass points next to a street name ("Avenue NW", "Östra"). */
const DIRECTIONS =
  /^(?:[NSEW]|NE|NW|SE|SW|North|South|East|West|Nord|Süd|Sud|Ost|Est|Ouest|Norra|Södra|Östra|Västra)[.,]?$/u;

/**
 * CJK road words; the name before them (not crossing a province, city,
 * county, district or town word) is the road's.
 */
const CJK_ROAD =
  /((?:(?![省市县区镇乡])[\p{Script=Han}\p{Script=Hangul}]){1,4})(路|街|道|巷|胡同|大道|로|길|대로)/gu;

/** Street types written onto the name (Hauptstraße, Kerkstraat, Storgatan). */
const GLUED_TYPES = [
  'straße',
  'strasse',
  'str.',
  'weg',
  'gasse',
  'platz',
  'allee',
  'ring',
  'damm',
  'ufer',
  'straat',
  'laan',
  'gracht',
  'plein',
  'gatan',
  'vägen',
  'gränd',
];

const SEPARATOR = /(\s*(?:,|\r?\n)\s*)/u;

interface Line {
  readonly start: number;
  readonly text: string;
}

function linesOf(value: string): Line[] {
  const lines: Line[] = [];
  let offset = 0;
  for (const part of value.split(SEPARATOR)) {
    if (part !== '' && !SEPARATOR.test(part)) {
      lines.push({ start: offset, text: part });
    }
    offset += part.length;
  }
  return lines;
}

function countryByName(lines: readonly Line[]): CountryCode | null {
  const last = lines[lines.length - 1];
  return last === undefined
    ? null
    : (COUNTRY_NAMES.get(last.text.trim().toLowerCase()) ?? null);
}

interface Postcode {
  readonly start: number;
  readonly end: number;
  readonly country: CountryCode;
}

/** The last postcode of `country`'s format, not on the first line. */
function postcodeOf(
  value: string,
  lines: readonly Line[],
  country: CountryCode,
): Postcode | null {
  const format = FORMATS[country];
  if (format === undefined) return null;
  const firstEnd =
    lines.length > 1
      ? (lines[0]?.start ?? 0) + (lines[0]?.text.length ?? 0)
      : 0;
  let found: Postcode | null = null;
  for (const match of value.matchAll(format.postcode)) {
    if (match.index >= firstEnd) {
      found = {
        start: match.index,
        end: match.index + match[0].length,
        country,
      };
    }
  }
  return found;
}

interface AddressPlan {
  readonly country: CountryCode | null;
  readonly postcode: Postcode | null;
  readonly locale: LocaleId;
}

function planAddress(
  value: string,
  requestCountry: CountryCode | null,
  homeRegions: readonly CountryCode[],
  preferred: readonly LocaleId[],
): AddressPlan {
  const lines = linesOf(value);
  const named = countryByName(lines);
  const candidates: CountryCode[] = named !== null ? [named] : [];
  if (named === null) {
    if (requestCountry !== null) candidates.push(requestCountry);
    candidates.push(...homeRegions);
    for (const code of Object.keys(FORMATS)) {
      candidates.push(code as CountryCode);
    }
  }
  let postcode: Postcode | null = null;
  for (const code of candidates) {
    postcode = postcodeOf(value, lines, code);
    if (postcode !== null) break;
  }
  const country = named ?? postcode?.country ?? requestCountry;
  const locale =
    (country === null ? undefined : localeForRegion(country)?.id) ??
    preferred[0] ??
    DEFAULT_LOCALE;
  return { country, postcode, locale };
}

const localeForRegionIds = new Map<LocaleId, CountryCode>();
for (const code of Object.keys(FORMATS) as CountryCode[]) {
  const locale = localeForRegion(code);
  if (locale !== undefined && !localeForRegionIds.has(locale.id)) {
    localeForRegionIds.set(locale.id, code);
  }
}

/** The preferred locales' regions (the first with a postcode format each). */
function regionsOf(preferred: readonly LocaleId[]): CountryCode[] {
  return preferred.flatMap((id) => {
    const region = localeForRegionIds.get(id);
    return region === undefined ? [] : [region];
  });
}

/** The locale an ADDRESS stand-in for `value` comes from. */
export function addressLocale(
  value: string,
  country: CountryCode | null,
  preferred: readonly LocaleId[],
): LocaleId {
  return planAddress(value, country, regionsOf(preferred), preferred).locale;
}

/** Digits replaced, a first digit never 0 when the real one is not. */
function digitsLike(rng: Rng, text: string): string {
  let out = text;
  for (let i = 0; i < 16 && out === text; i += 1) {
    let first = true;
    out = text.replace(/\d/gu, (digit) => {
      const keepNonZero = first && digit !== '0';
      first = false;
      return keepNonZero ? rng.char('123456789') : rng.char(DIGITS);
    });
  }
  return out;
}

/** A postcode template matching the real one's shape (# ? and classes). */
function templateFits(template: string, real: string): boolean {
  const slots = templateSlots(template);
  const chars = Array.from(real);
  return (
    slots.length === chars.length &&
    slots.every((slot, i) => {
      const char = chars[i] ?? '';
      if (slot === '#') return /\d/u.test(char);
      if (slot === '?') return /[A-Za-z]/u.test(char);
      if (slot.length > 1) {
        return /\d/u.test(char) === /\d/u.test(slot.charAt(0));
      }
      return slot === char || (/[A-Z]/iu.test(slot) && /[A-Z]/iu.test(char));
    })
  );
}

/** A template as slots: "#", "?", a class's characters, or a literal. */
function templateSlots(template: string): string[] {
  const slots: string[] = [];
  for (let i = 0; i < template.length; i += 1) {
    const char = template.charAt(i);
    if (char === '[') {
      const end = template.indexOf(']', i);
      slots.push(template.slice(i + 1, end));
      i = end;
    } else {
      slots.push(char);
    }
  }
  return slots;
}

function fillTemplate(rng: Rng, template: string): string {
  return templateSlots(template)
    .map((slot) => {
      if (slot === '#') return rng.char(DIGITS);
      if (slot === '?') return rng.char(UPPER);
      return slot.length > 1 ? rng.char(slot) : slot;
    })
    .join('');
}

/** A new postcode: a list template of the same shape, else the same shape. */
function postcodeLike(rng: Rng, real: string, words: LocaleWords): string {
  const templates = words.postcodes.filter((template) =>
    templateFits(template, real),
  );
  for (let i = 0; i < 16; i += 1) {
    const out =
      templates.length > 0
        ? fillTemplate(rng, rng.pick(templates))
        : real.replace(/[A-Za-z\d]/gu, (char) =>
            /\d/u.test(char)
              ? rng.char(DIGITS)
              : char === char.toUpperCase()
                ? rng.char(UPPER)
                : rng.char(LOWER),
          );
    const cased = real === real.toLowerCase() ? out.toLowerCase() : out;
    if (cased.replace(/\s/gu, '') !== real.replace(/\s/gu, '')) return cased;
  }
  return real;
}

interface Replacer {
  readonly rng: Rng;
  readonly words: LocaleWords;
  readonly avoid: Set<string>;
}

function nameWord(replacer: Replacer, like: string): string | null {
  const picked = pickWord(
    replacer.rng,
    familyNames(replacer.words, null).filter((name) => !/[\s-]/u.test(name)),
    replacer.avoid,
  );
  if (picked === null) return null;
  replacer.avoid.add(picked.toLowerCase());
  return inCaseOf(like, picked);
}

function localityLike(replacer: Replacer, like: string): string | null {
  const picked = pickWord(
    replacer.rng,
    replacer.words.localities,
    replacer.avoid,
  );
  if (picked === null) return null;
  replacer.avoid.add(picked.toLowerCase());
  return inCaseOf(like, picked);
}

/** Every street type the address may use, lower case. */
function streetTypes(words: LocaleWords): Set<string> {
  return new Set([
    ...words.streetTypes.map((type) => type.toLowerCase()),
    ...STREET_TYPES,
  ]);
}

/**
 * `text` with each match of `pattern` (global) replaced by `replace`, or
 * null when one of them cannot be.
 */
function mapMatches(
  text: string,
  pattern: RegExp,
  replace: (match: RegExpExecArray) => string | null,
): string | null {
  let out = '';
  let cursor = 0;
  for (const match of text.matchAll(pattern)) {
    const next = replace(match);
    if (next === null) return null;
    out += text.slice(cursor, match.index) + next;
    cursor = match.index + match[0].length;
  }
  return out + text.slice(cursor);
}

const WORD = /[^\s]+/gu;

/**
 * The street line: numbers replaced, a glued type kept on a new stem, type
 * words and unit words kept, the other words replaced by family names.
 */
function streetLine(replacer: Replacer, line: string): string | null {
  const types = streetTypes(replacer.words);
  const gluedTypes = [
    ...GLUED_TYPES,
    ...(replacer.words.streetTypeOrder === 'glued'
      ? replacer.words.streetTypes.map((type) => type.toLowerCase())
      : []),
  ]
    .filter((type) => type.length >= 3)
    .sort((a, b) => b.length - a.length);
  let unitNext = false;
  return mapMatches(line, WORD, ([word]) => {
    const lower = word.toLowerCase();
    const afterUnit = unitNext;
    unitNext = false;
    if (/\d/u.test(word)) {
      return word.replace(/\d+/gu, (digits) =>
        digitsLike(replacer.rng, digits),
      );
    }
    if (UNIT_WORDS.test(word)) {
      unitNext = true;
      return word;
    }
    if (afterUnit && /^[A-Za-z]$/u.test(word)) {
      return replacer.rng.char(word === word.toLowerCase() ? LOWER : UPPER);
    }
    if (types.has(lower) || types.has(lower.replace(/[.,]$/u, ''))) return word;
    if (/^(?:de|del|la|le|du|des|da|do|dos|das|di|of|the|and)$/u.test(lower)) {
      return word;
    }
    if (DIRECTIONS.test(word)) return word;
    const type = gluedTypes.find(
      (candidate) =>
        lower.endsWith(candidate) && lower.length >= candidate.length + 2,
    );
    if (type !== undefined) {
      const stem = word.slice(0, word.length - type.length);
      const name = nameWord(replacer, stem);
      return name === null ? null : name + word.slice(stem.length);
    }
    return nameWord(replacer, word);
  });
}

/** Where the street ends in `text`: after its last number or street type. */
function streetEnd(text: string, types: ReadonlySet<string>): number {
  let end = 0;
  for (const match of text.matchAll(WORD)) {
    const lower = match[0].toLowerCase();
    if (
      /\d/u.test(lower) ||
      types.has(lower.replace(/[.,]$/u, '')) ||
      GLUED_TYPES.some((type) => lower.endsWith(type))
    ) {
      end = match.index + match[0].length;
    }
  }
  return end;
}

/** Digits replaced and road names renamed (addresses in CJK scripts). */
function cjkAddress(replacer: Replacer, value: string): string | null {
  const family = familyNames(replacer.words, null);
  const given = givenNames(replacer.words, null);
  const renamed = mapMatches(value, CJK_ROAD, ([, name = '', road = '']) => {
    const length = Array.from(name).length;
    const picked =
      pickWord(replacer.rng, family, replacer.avoid, length) ??
      pickWord(replacer.rng, given, replacer.avoid, length);
    return picked === null ? null : picked + road;
  });
  return (
    renamed?.replace(/\d+/gu, (digits) => digitsLike(replacer.rng, digits)) ??
    null
  );
}

/** The stand-in for an address, or null when no list could give one. */
export function addressStandInFor(
  value: string,
  country: CountryCode | null,
  rng: Rng,
  env: StandInEnvironment,
): { value: string; locale: LocaleId } | null {
  const plan = planAddress(
    value,
    country,
    regionsOf(env.preferredLocales),
    env.preferredLocales,
  );
  const words = wordsOf(env, plan.locale);
  const replacer: Replacer = { rng, words, avoid: new Set() };
  if (CJK.has(scriptOf(value))) {
    const out = cjkAddress(replacer, value);
    return out === null ? null : { value: out, locale: plan.locale };
  }

  const lines = linesOf(value);
  for (const line of lines) {
    for (const word of line.text.split(/\s+/u)) {
      replacer.avoid.add(word.toLowerCase());
    }
  }
  const countryLine =
    countryByName(lines) !== null ? lines.length - 1 : lines.length;
  const postcode = plan.postcode;
  const postcodeLine =
    postcode === null
      ? -1
      : lines.findIndex(
          (line) =>
            postcode.start >= line.start &&
            postcode.end <= line.start + line.text.length,
        );
  const types = streetTypes(words);
  const isStreet = (text: string): boolean =>
    /\d/u.test(text) ||
    text.split(/\s+/u).some((word) => types.has(word.toLowerCase()));
  let streetIndex = lines.findIndex(
    (line, i) => i < countryLine && i !== postcodeLine && isStreet(line.text),
  );
  if (streetIndex < 0) streetIndex = 0;

  // The city: on the postcode's line, or the line before when that line
  // holds only the postcode and a state code ("CA 94043").
  let cityIndex = -1;
  if (postcodeLine >= 0) {
    const line = lines[postcodeLine];
    const rest =
      line === undefined || postcode === null
        ? ''
        : (
            value.slice(line.start, postcode.start) +
            value.slice(postcode.end, line.start + line.text.length)
          ).trim();
    cityIndex =
      rest === '' || /^[A-Z]{2,3}$/u.test(rest)
        ? postcodeLine - 1
        : postcodeLine;
  } else if (countryLine - 1 > streetIndex) {
    cityIndex = countryLine - 1;
  }

  let out = '';
  let cursor = 0;
  for (const [i, line] of lines.entries()) {
    out += value.slice(cursor, line.start);
    cursor = line.start + line.text.length;
    let text = line.text;
    if (i === countryLine) {
      out += text;
      continue;
    }
    if (i === postcodeLine && postcode !== null) {
      const offset = postcode.start - line.start;
      const length = postcode.end - postcode.start;
      const before = text.slice(0, offset);
      const after = text.slice(offset + length);
      const code = postcodeLike(
        rng,
        text.slice(offset, offset + length),
        words,
      );
      const city = i === cityIndex && !env.keepCity;
      const swap = (part: string): string | null =>
        city
          ? replaceWords(part, (word) =>
              /^[A-Z]{2,3}$/u.test(word) ? word : localityLike(replacer, word),
            )
          : part;
      // One line for everything ("221B Baker Street London NW1 6XE"): the
      // street runs to its last number or street type, the city follows.
      let street = '';
      let rest = before;
      if (i === streetIndex) {
        const cut = streetEnd(before, types);
        const replaced = streetLine(replacer, before.slice(0, cut));
        if (replaced === null) return null;
        street = replaced;
        rest = before.slice(cut);
      }
      const head = swap(rest);
      const tail = swap(after);
      if (head === null || tail === null) return null;
      out += street + head + code + tail;
      continue;
    }
    if (i === streetIndex) {
      const street = streetLine(replacer, text);
      if (street === null) return null;
      text = street;
    } else if (i === cityIndex) {
      if (!env.keepCity) {
        const city = localityLike(replacer, text);
        if (city === null) return null;
        text = city;
      }
    } else if (i > streetIndex && (cityIndex < 0 || i < cityIndex)) {
      // Lines between the street and the city: localities.
      const locality = /\d/u.test(text)
        ? streetLine(replacer, text)
        : localityLike(replacer, text);
      if (locality === null) return null;
      text = locality;
    } else if (i < streetIndex) {
      // A line before the street (building, flat): numbers replaced.
      text = text.replace(/\d+/gu, (digits) => digitsLike(rng, digits));
    }
    out += text;
  }
  out += value.slice(cursor);
  return out === value ? null : { value: out, locale: plan.locale };
}

function replaceWords(
  text: string,
  replace: (word: string) => string | null,
): string | null {
  return mapMatches(text, WORD, ([word]) => replace(word));
}

export const addressStandIn: Generator = ({ request, rng, env }) => {
  const address = addressStandInFor(request.value, request.country, rng, env);
  return address === null
    ? null
    : { value: address.value, reserved: false, locale: address.locale };
};

/** Keeps the line structure: the same separators in the same order. */
export function isWellFormedAddressStandIn(
  standIn: string,
  real: string,
): boolean {
  const separators = (text: string): string[] =>
    text.split(SEPARATOR).filter((part) => SEPARATOR.test(part));
  const a = separators(standIn);
  const b = separators(real);
  return a.length === b.length && a.every((part, i) => part === b[i]);
}
