/**
 * Stand-ins a reply wrote in another form than the one sent (TR-X2):
 * number-like values with other separators, spacing or case, phone numbers
 * with another prefix or grouping, and card last-four mentions.
 *
 * Every variant needs at least MIN_FORM_LENGTH letters or digits (so at
 * least six digits for a number made of digits only) and clean boundaries:
 * not glued to letters, digits or underscores, and not continued by a
 * separator and a digit (part of a longer number).
 */
import type { EntityType } from '../../shared/entities.ts';
import { CALLING_CODES } from '../net/calling-codes.ts';
import { compactForm, MIN_FORM_LENGTH } from '../net/compact.ts';
import { INTERNATIONAL_PREFIXES, nationalPrefix } from './phone-prefixes.ts';
import type { StandInMapping, StandInVariants } from './types.ts';

/** A variant found in text, with the text that replaces it. */
export interface VariantMatch {
  readonly start: number;
  readonly end: number;
  readonly real: string;
}

export interface VariantFinder {
  /** Variants in `text`, left to right, possibly overlapping. */
  find(text: string): VariantMatch[];
  /** Card last-four mentions, outside the given (sorted) taken spans. */
  findLastFour(
    text: string,
    taken: readonly { start: number; end: number }[],
  ): VariantMatch[];
  /** Occurrences of any variant form, ignoring boundaries (leak check). */
  count(text: string): number;
}

/** The variants of a stand-in of this type, if it has any. */
export function variantsFor(
  type: EntityType,
  standIn: string,
  normalised: string,
): StandInVariants | undefined {
  // Variant patterns also match the stand-in as shown, so only stand-ins
  // they can spell get variants (the leak check counts through them).
  if (type === 'PHONE') {
    return SPELLED_PHONE.test(standIn)
      ? phoneVariants(standIn, normalised)
      : undefined;
  }
  if (type === 'CARD' || type === 'BANK' || type === 'NATIONAL_ID') {
    return SPELLED_LAYOUT.test(standIn) &&
      compactForm(standIn).length >= MIN_FORM_LENGTH
      ? { kind: 'layout', card: type === 'CARD' }
      : undefined;
  }
  return undefined;
}

/**
 * A phone stand-in keeps the real number's calling code, length and written
 * prefix; its national significant number is the last digits as written.
 */
function phoneVariants(
  standIn: string,
  normalised: string,
): StandInVariants | undefined {
  if (!normalised.startsWith('+')) return undefined;
  const digits = normalised.slice(1).replace(/\D/gu, '');
  const callingCode = CALLING_CODES.find((code) => digits.startsWith(code));
  if (callingCode === undefined) return undefined;
  const realNumber = digits.slice(callingCode.length);
  const shown = standIn.replace(/\D/gu, '');
  if (realNumber.length < MIN_FORM_LENGTH || shown.length < realNumber.length) {
    return undefined;
  }
  return {
    kind: 'phone',
    callingCode,
    standInNumber: shown.slice(shown.length - realNumber.length),
    realNumber,
  };
}

/** Separators allowed between the characters of a number-like value. */
const LAYOUT_SEPARATOR = /[ \u00A0\u2007\u202F.\-\u2010-\u2013]/u;
/** Stand-ins the variant scan can spell: at most 3 separators in a row. */
const SPELLED_LAYOUT =
  /^[\p{L}\p{N}](?:[ \u00A0\u2007\u202F.\-\u2010-\u2013]{0,3}[\p{L}\p{N}])*$/u;
const SPELLED_PHONE =
  /^\+?\(?\d(?:[ \u00A0\u2007\u202F.\-\u2010-\u2013/()]{0,3}\d)*$/u;
/** Phone separators also include brackets and slashes. */
const SEPARATOR = /[ \u00A0\u2007\u202F.\-\u2010-\u2013/()]/u;
const GLUED = /[\p{L}\p{N}_]/u;
const DIGIT = /\d/u;
const ALNUM = /[\p{L}\p{N}]/u;
const LETTER = /\p{L}/u;

/** Words and marks that introduce a card's last four digits. */
const CARD_CUE =
  /(?:ending|ends)\s+(?:in|with)|last\s+(?:4|four)|\bcards?\b|\bvisa\b|master\s?card|\bamex\b|american\s+express|\bdiscover\b|\bdiners\b|\bjcb\b|union\s?pay|\bmaestro\b|[*\u2022x]{4}/iu;
/** Characters before a last-four mention searched for a card cue. */
const CUE_WINDOW = 30;

/** True when [start, end) is not part of a longer word or number. */
function isClean(text: string, start: number, end: number): boolean {
  const before = text.charAt(start - 1);
  const after = text.charAt(end);
  if (GLUED.test(before) || GLUED.test(after) || before === '+') return false;
  if (SEPARATOR.test(before) && DIGIT.test(text.charAt(start - 2))) {
    return false;
  }
  return !(SEPARATOR.test(after) && DIGIT.test(text.charAt(end + 1)));
}

/** The letters and digits of a value, as written. */
function charsOf(value: string): string[] {
  return Array.from(value).filter((char) => ALNUM.test(char));
}

/**
 * Writes `real`'s letters and digits into the layout of `shown`: its
 * separators stay, and each letter takes the case `shown` has there. Null
 * when the two do not have the same number of letters and digits.
 */
export function transferLayout(
  shown: string,
  real: readonly string[],
): string | null {
  let out = '';
  let next = 0;
  for (const char of shown) {
    if (!ALNUM.test(char)) {
      out += char;
      continue;
    }
    const value = real[next];
    if (value === undefined) return null;
    next += 1;
    if (!LETTER.test(char)) out += value;
    else if (char !== char.toUpperCase()) out += value.toLowerCase();
    else out += value.toUpperCase();
  }
  return next === real.length ? out : null;
}
/**
 * A stretch of text whose letters and digits (phones: digits) are joined by
 * at most MAX_GAP separators. Every variant lies inside one run, so finding
 * them is a dictionary lookup over each run's characters: linear in the
 * text, whatever the number of stand-ins.
 */
interface Run {
  /**
   * The run's letters and digits, lower case, one UTF-16 unit each (a
   * character that does not fit one unit stands as U+FFFF, which no key
   * contains).
   */
  readonly compact: string;
  /** Offset of each character in the text, and the offset after it. */
  readonly from: number[];
  readonly to: number[];
  /** True where a separator comes before the character (or it is first). */
  readonly tokenStart: boolean[];
  /** Offset of a "+" right before the first character, or -1. */
  readonly plus: number;
}

/** Separators allowed in a row inside a value. */
const MAX_GAP = 3;

const MEMBER = 1;
const GAP = 2;
const OTHER = 0;

/** Whether a character belongs to a run, separates inside one, or ends it. */
function classify(code: number, char: string, phone: boolean): number {
  if (code < 128) {
    if (code >= 48 && code <= 57) return MEMBER;
    const letter = (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
    if (letter) return phone ? OTHER : MEMBER;
    // Space, hyphen, dot; phones also slash and brackets.
    if (code === 32 || code === 45 || code === 46) return GAP;
    return phone && (code === 47 || code === 40 || code === 41) ? GAP : OTHER;
  }
  if (!phone && ALNUM.test(char)) return MEMBER;
  return (phone ? SEPARATOR : LAYOUT_SEPARATOR).test(char) ? GAP : OTHER;
}

function runsOf(text: string, phone: boolean): Run[] {
  const runs: Run[] = [];
  let run: { -readonly [K in keyof Run]: Run[K] } | null = null;
  let units: number[] = [];
  const close = (): void => {
    if (run !== null) run.compact = String.fromCharCode(...units);
    run = null;
    units = [];
  };
  let gap = 0;
  for (let i = 0; i < text.length;) {
    const code = text.codePointAt(i) ?? 0;
    const next = i + (code > 0xffff ? 2 : 1);
    const char = code < 128 ? '' : text.slice(i, next);
    const kind = classify(code, char, phone);
    if (kind === MEMBER) {
      if (run === null) {
        run = {
          compact: '',
          from: [],
          to: [],
          tokenStart: [],
          plus: text.charAt(i - 1) === '+' ? i - 1 : -1,
        };
        runs.push(run);
      }
      run.tokenStart.push(units.length === 0 || gap > 0);
      if (code < 128) {
        units.push(code >= 65 && code <= 90 ? code + 32 : code);
      } else {
        const lower = char.toLowerCase();
        units.push(lower.length === 1 ? lower.charCodeAt(0) : 0xffff);
      }
      run.from.push(i);
      run.to.push(next);
      gap = 0;
    } else if (run !== null && kind === GAP && gap < MAX_GAP) {
      gap += 1;
    } else {
      close();
      gap = 0;
    }
    i = next;
  }
  close();
  return runs;
}

const isTokenEnd = (run: Run, index: number): boolean =>
  index === run.compact.length - 1 || run.tokenStart[index + 1] === true;

const keyOf = (run: Run, start: number, end: number): string =>
  run.compact.slice(start, end + 1);

interface PhoneEntry {
  readonly callingCode: string;
  readonly trunk: string | null;
  readonly realNumber: string;
}

/** True when `prefix` (digits) may precede the number as written. */
function prefixFits(entry: PhoneEntry, prefix: string, plus: boolean): boolean {
  if (prefix === '') return !plus;
  const { callingCode: code, trunk } = entry;
  const international = [code, ...(trunk === null ? [] : [code + trunk])];
  if (plus) return international.includes(prefix);
  if (prefix === trunk) return true;
  return INTERNATIONAL_PREFIXES.some((idd) =>
    international.some((rest) => prefix === idd + rest),
  );
}

const NO_VARIANTS: VariantFinder = {
  find: () => [],
  findLastFour: () => [],
  count: () => 0,
};

/** Characters a key starts with that are checked before any lookup. */
const HEAD = 3;

/** A set of keys with a cheap test for where one may start. */
interface KeySet {
  readonly heads: ReadonlySet<string>;
  /** Distinct lengths, longest first, so the longest key wins. */
  readonly lengths: readonly number[];
  has(key: string): boolean;
}

function keySet(keys: ReadonlyMap<string, unknown>): KeySet {
  return {
    heads: new Set(Array.from(keys.keys(), (key) => key.slice(0, HEAD))),
    lengths: lengthsOf(keys.keys()),
    has: (key) => keys.has(key),
  };
}

/** Distinct key lengths, longest first, so the longest key wins. */
const lengthsOf = (keys: Iterable<string>): number[] =>
  [...new Set(Array.from(keys, (key) => key.length))].sort((a, b) => b - a);

export function createVariantFinder(
  mappings: Iterable<StandInMapping>,
): VariantFinder {
  const layouts = new Map<string, StandInMapping>();
  /** Phone stand-ins by their national significant number. */
  const phones = new Map<string, PhoneEntry[]>();
  /** Card stand-ins by their last four digits. */
  const lastFour = new Map<string, StandInMapping[]>();
  for (const mapping of mappings) {
    const { variants } = mapping;
    if (variants?.kind === 'layout') {
      const compact = compactForm(mapping.standIn);
      if (compact.length < MIN_FORM_LENGTH) continue;
      layouts.set(compact, mapping);
      const digits = compact.replace(/\D/gu, '');
      if (variants.card && digits.length >= 4) {
        const key = digits.slice(-4);
        lastFour.set(key, [...(lastFour.get(key) ?? []), mapping]);
      }
    } else if (variants?.kind === 'phone') {
      const key = variants.standInNumber;
      if (key.length < MIN_FORM_LENGTH) continue;
      const entry: PhoneEntry = {
        callingCode: variants.callingCode,
        trunk: nationalPrefix(variants.callingCode),
        realNumber: variants.realNumber,
      };
      phones.set(key, [...(phones.get(key) ?? []), entry]);
    }
  }
  if (layouts.size === 0 && phones.size === 0) return NO_VARIANTS;
  // Keys are at least MIN_FORM_LENGTH long, so longer than HEAD.
  const layoutKeys = keySet(layouts);
  const phoneKeys = keySet(phones);

  const findLayouts = (text: string, out: VariantMatch[]): void => {
    if (layouts.size === 0) return;
    for (const run of runsOf(text, false)) {
      for (let i = 0; i < run.compact.length; i += 1) {
        if (run.tokenStart[i] !== true) continue;
        if (!layoutKeys.heads.has(run.compact.slice(i, i + HEAD))) continue;
        for (const length of layoutKeys.lengths) {
          const j = i + length - 1;
          if (j >= run.compact.length || !isTokenEnd(run, j)) continue;
          const mapping = layouts.get(keyOf(run, i, j));
          const start = run.from[i] ?? 0;
          const end = run.to[j] ?? 0;
          if (mapping === undefined || !isClean(text, start, end)) continue;
          const shown = text.slice(start, end);
          const real =
            transferLayout(shown, charsOf(mapping.real)) ?? mapping.real;
          out.push({ start, end, real });
          i = j;
          break;
        }
      }
    }
  };

  /**
   * The number may follow any prefix inside its run: none, a national
   * prefix, "+" and the calling code, or an international dialling prefix
   * and the calling code (either with the national prefix, as in
   * "+44 (0)"). The longest prefix that fits wins.
   */
  const findPhones = (text: string, out: VariantMatch[]): void => {
    if (phones.size === 0) return;
    for (const run of runsOf(text, true)) {
      let floor = 0;
      for (let j = 0; j < run.compact.length; j += 1) {
        if (!isTokenEnd(run, j)) continue;
        search: for (const length of phoneKeys.lengths) {
          const i = j - length + 1;
          if (i < floor) continue;
          const entries = phones.get(keyOf(run, i, j));
          if (entries === undefined) continue;
          for (let s = floor; s <= i; s += 1) {
            if (run.tokenStart[s] !== true) continue;
            const prefix = run.compact.slice(s, i);
            const plus = s === 0 && run.plus >= 0;
            const entry = entries.find((e) => prefixFits(e, prefix, plus));
            const start = plus ? run.plus : (run.from[s] ?? 0);
            const end = run.to[j] ?? 0;
            if (entry === undefined || !isClean(text, start, end)) continue;
            const split = run.from[i] ?? 0;
            const real =
              text.slice(start, split) +
              (transferLayout(
                text.slice(split, end),
                Array.from(entry.realNumber),
              ) ?? entry.realNumber);
            out.push({ start, end, real });
            floor = j + 1;
            break search;
          }
        }
      }
    }
  };

  /** Keys anywhere in the runs, glued or not; each character counts once. */
  const countIn = (runs: readonly Run[], keys: KeySet): number => {
    let total = 0;
    for (const run of runs) {
      for (let i = 0; i < run.compact.length; i += 1) {
        if (!keys.heads.has(run.compact.slice(i, i + HEAD))) continue;
        for (const length of keys.lengths) {
          const j = i + length - 1;
          if (j < run.compact.length && keys.has(keyOf(run, i, j))) {
            total += 1;
            i = j;
            break;
          }
        }
      }
    }
    return total;
  };

  return {
    find(text) {
      const out: VariantMatch[] = [];
      findLayouts(text, out);
      findPhones(text, out);
      return out.sort((a, b) => a.start - b.start || b.end - a.end);
    },

    findLastFour(text, taken) {
      if (lastFour.size === 0) return [];
      const out: VariantMatch[] = [];
      const pattern = /\d{4}/gu;
      for (
        let match = pattern.exec(text);
        match !== null;
        match = pattern.exec(text)
      ) {
        const start = match.index;
        const end = start + 4;
        const cards = lastFour.get(match[0]);
        if (cards?.length !== 1 || !isClean(text, start, end)) continue;
        if (taken.some((span) => span.start < end && start < span.end)) {
          continue;
        }
        const from = Math.max(0, start - CUE_WINDOW);
        const before = text.slice(from, start);
        const window = before.slice(before.lastIndexOf('\n') + 1);
        if (!CARD_CUE.test(window)) continue;
        const [card] = cards;
        const digits = card === undefined ? '' : card.real.replace(/\D/gu, '');
        const real = digits.slice(-4);
        if (real.length === 4 && real !== match[0]) {
          out.push({ start, end, real });
        }
      }
      return out;
    },

    count(text) {
      return (
        (layouts.size === 0 ? 0 : countIn(runsOf(text, false), layoutKeys)) +
        (phones.size === 0 ? 0 : countIn(runsOf(text, true), phoneKeys))
      );
    },
  };
}
