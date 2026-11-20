/**
 * Written dates: finding them in text, reading them, and writing another
 * date in exactly the same way (separators, zero padding, month-name
 * language, form and case, 2- or 4-digit year, ordinal suffix, digits).
 *
 * Formats: numeric with "/", "-" or "." (day, month and year in any of the
 * orders DMY, MDY, YMD; 2- or 4-digit years), ISO 8601, written months in
 * English, German, French, Spanish, Italian and Portuguese (day first, or
 * month first as in "March 12, 1990"), and 1990年3月12日 (also with 년 월 일).
 *
 * A numeric date whose day and month are both 12 or less can be read two
 * ways; `readDate` resolves that with the region's convention and says so.
 */
import type { CountryCode } from '../../shared/country.ts';
import {
  fullYear,
  isRealDate,
  isoDate,
  pad,
  type CalendarDate,
} from './calendar.ts';
import {
  MONTH_LANGUAGES,
  MONTH_SPELLINGS,
  monthName,
  monthWords,
  type MonthForm,
  type MonthLanguage,
} from './months.ts';

/** The order of day, month and year in a written date. */
export type DateOrder = 'DMY' | 'MDY' | 'YMD';

export const DATE_ORDERS: readonly DateOrder[] = ['DMY', 'MDY', 'YMD'];

export function isDateOrder(value: unknown): value is DateOrder {
  return (DATE_ORDERS as readonly unknown[]).includes(value);
}

type LetterCase = 'lower' | 'upper' | 'title';

type Token =
  | { readonly kind: 'num'; readonly text: string }
  | {
      readonly kind: 'month';
      readonly text: string;
      readonly month: number;
      readonly language: MonthLanguage;
      readonly form: MonthForm;
      readonly plain: boolean;
      readonly letterCase: LetterCase;
    }
  /** An ordinal mark right after the day: st, nd, rd, th, er, º, °. */
  | { readonly kind: 'ordinal'; readonly text: string }
  | { readonly kind: 'lit'; readonly text: string };

/** A written date taken apart, ready to be read or rewritten. */
export interface DateWriting {
  readonly tokens: readonly Token[];
  /** The orders its parts can be read in, most natural first. */
  readonly orders: readonly DateOrder[];
}

const ORDINALS = new Set(['st', 'nd', 'rd', 'th', 'er', 'o', 'º', '°']);
/** Ordinal marks that belong to the first of the month only (1er, 1º). */
const FIRST_ONLY = new Set(['er', 'o', 'º', '°']);
/** Words between parts that hint at a month name's language. */
const LANGUAGE_HINTS: readonly (readonly [RegExp, readonly MonthLanguage[]])[] =
  [
    [/\b(?:of|st|nd|rd|th)\b/iu, ['en']],
    [/\bdel\b/iu, ['es']],
    [/\bde\b/iu, ['es', 'pt', 'fr']],
    [/\ber\b/iu, ['fr']],
    [/\d\.\s/u, ['de']],
  ];

const DIGIT_RUN = /^\p{Nd}+$/u;
const LETTER = /\p{L}/u;

function digitValue(char: string): number {
  return Number(char.normalize('NFKC'));
}

function numberOf(text: string): number {
  let value = 0;
  for (const char of text) value = value * 10 + digitValue(char);
  return value;
}

/** ASCII digits written in the digit set `like` uses (e.g. full width). */
function inDigitsOf(digits: string, like: string): string {
  const first = like.codePointAt(0) ?? 48;
  if (first < 128) return digits;
  const zero = first - digitValue(like.charAt(0));
  return Array.from(digits, (digit) =>
    String.fromCodePoint(zero + Number(digit)),
  ).join('');
}

function letterCaseOf(text: string): LetterCase {
  if (text === text.toUpperCase() && text !== text.toLowerCase()) {
    return text.length > 1 ? 'upper' : 'title';
  }
  const first = text.charAt(0);
  return first === first.toUpperCase() ? 'title' : 'lower';
}

function inCase(text: string, letterCase: LetterCase): string {
  if (letterCase === 'upper') return text.toUpperCase();
  if (letterCase === 'lower') return text;
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Splits text into digit runs, letter runs, degree signs and the rest. */
function pieces(text: string): string[] {
  return text.match(/\p{Nd}+|\p{L}+|°|[^\p{Nd}\p{L}°]+/gu) ?? [];
}

function chooseLanguage(
  words: readonly { language: MonthLanguage }[],
  text: string,
): MonthLanguage | null {
  const languages = new Set(words.map((word) => word.language));
  for (const [hint, hinted] of LANGUAGE_HINTS) {
    if (!hint.test(text)) continue;
    const found = hinted.find((language) => languages.has(language));
    if (found !== undefined) return found;
  }
  return MONTH_LANGUAGES.find((language) => languages.has(language)) ?? null;
}

/** The orders a date's parts can be read in, from their widths. */
function ordersOf(tokens: readonly Token[]): DateOrder[] {
  const nums = tokens.filter((token) => token.kind === 'num');
  const monthAt = tokens.findIndex((token) => token.kind === 'month');
  const widths = nums.map((token) => token.text.length);
  if (monthAt >= 0) {
    if (nums.length !== 2) return [];
    const [first, second] = widths;
    if (first === undefined || second === undefined) return [];
    const firstAt = tokens.findIndex((token) => token.kind === 'num');
    if (firstAt > monthAt) {
      // March 12, 1990
      return first <= 2 && second === 4 ? ['MDY'] : [];
    }
    if (first === 4 && second <= 2) return ['YMD'];
    return first <= 2 && (second === 4 || second === 2) ? ['DMY'] : [];
  }
  if (nums.length !== 3) return [];
  const [a, b, c] = widths;
  if (a === undefined || b === undefined || c === undefined) return [];
  if (a === 4) return b <= 2 && c <= 2 ? ['YMD'] : [];
  if (a > 2 || b > 2) return [];
  if (c === 4) return ['DMY', 'MDY'];
  if (c !== 2) return [];
  // A 2-digit year may also come first (90/03/12).
  return a === 2 ? ['DMY', 'MDY', 'YMD'] : ['DMY', 'MDY'];
}

/** Takes a written date apart; null when it is not one of the formats. */
export function parseDateWriting(text: string): DateWriting | null {
  const tokens: Token[] = [];
  let months = 0;
  for (const piece of pieces(text)) {
    const previous = tokens.at(-1);
    if (DIGIT_RUN.test(piece)) {
      tokens.push({ kind: 'num', text: piece });
    } else if (LETTER.test(piece)) {
      const lower = piece.toLowerCase();
      const words = monthWords(lower);
      const language = chooseLanguage(words, text);
      const word = words.find((entry) => entry.language === language);
      if (word !== undefined) {
        months += 1;
        tokens.push({
          kind: 'month',
          text: piece,
          month: word.month,
          language: word.language,
          form: word.form,
          plain: word.plain,
          letterCase: letterCaseOf(piece),
        });
      } else if (previous?.kind === 'num' && ORDINALS.has(lower)) {
        tokens.push({ kind: 'ordinal', text: piece });
      } else {
        tokens.push({ kind: 'lit', text: piece });
      }
    } else if (previous?.kind === 'num' && ORDINALS.has(piece)) {
      tokens.push({ kind: 'ordinal', text: piece });
    } else {
      tokens.push({ kind: 'lit', text: piece });
    }
  }
  if (months > 1) return null;
  const orders = ordersOf(tokens);
  return orders.length === 0 ? null : { tokens, orders };
}

/** Which number token holds which part, for an order. */
function roles(
  writing: DateWriting,
  order: DateOrder,
): { day: number; month: number; year: number } | null {
  if (!writing.orders.includes(order)) return null;
  const nums: number[] = [];
  let month = -1;
  for (const [index, token] of writing.tokens.entries()) {
    if (token.kind === 'num') nums.push(index);
    if (token.kind === 'month') month = index;
  }
  if (month >= 0) {
    const [first, second] = nums;
    if (first === undefined || second === undefined) return null;
    return order === 'YMD'
      ? { year: first, month, day: second }
      : { day: first, month, year: second };
  }
  const [a, b, c] = nums;
  if (a === undefined || b === undefined || c === undefined) return null;
  if (order === 'DMY') return { day: a, month: b, year: c };
  if (order === 'MDY') return { month: a, day: b, year: c };
  return { year: a, month: b, day: c };
}

/** The date a writing stands for when read in `order`, if it is a real one. */
export function readAs(
  writing: DateWriting,
  order: DateOrder,
  today: CalendarDate,
): CalendarDate | null {
  const parts = roles(writing, order);
  if (parts === null) return null;
  const { tokens } = writing;
  const yearToken = tokens[parts.year];
  const monthToken = tokens[parts.month];
  const dayToken = tokens[parts.day];
  if (
    yearToken?.kind !== 'num' ||
    dayToken?.kind !== 'num' ||
    monthToken === undefined
  ) {
    return null;
  }
  const yearValue = numberOf(yearToken.text);
  const year =
    yearToken.text.length === 2 ? fullYear(yearValue, today) : yearValue;
  const month =
    monthToken.kind === 'month'
      ? monthToken.month
      : monthToken.kind === 'num'
        ? numberOf(monthToken.text)
        : 0;
  const day = numberOf(dayToken.text);
  return isRealDate(year, month, day) ? { year, month, day } : null;
}

function englishOrdinal(day: number): string {
  const tens = day % 100;
  if (tens >= 11 && tens <= 13) return 'th';
  return ['th', 'st', 'nd', 'rd'][day % 10] ?? 'th';
}

/**
 * `date` written exactly the way `writing` is written when read in
 * `order`: same separators and words, each number in the same width (zero
 * padding kept, a 2-digit year stays 2 digits), the month name in the same
 * language, form and case, and an ordinal mark that fits the new day.
 */
export function writeAs(
  writing: DateWriting,
  order: DateOrder,
  date: CalendarDate,
): string | null {
  const parts = roles(writing, order);
  if (parts === null) return null;
  const originalDay = readDay(writing, parts.day);
  const named = writing.tokens.some((token) => token.kind === 'month');
  let out = '';
  for (const [index, token] of writing.tokens.entries()) {
    if (token.kind === 'num') {
      if (index === parts.year) {
        const year = token.text.length === 2 ? date.year % 100 : date.year;
        out += inDigitsOf(pad(year, token.text.length), token.text);
        continue;
      }
      const value = index === parts.month ? date.month : date.day;
      // A leading zero shows padding; "12" does not say, so numeric dates
      // are padded and dates with a month name are not.
      const padded =
        token.text.length === 2 &&
        (digitValue(token.text.charAt(0)) === 0 || !named);
      out += inDigitsOf(pad(value, padded ? 2 : 1), token.text);
    } else if (token.kind === 'month') {
      out += inCase(
        monthName(token.language, date.month, token.form, token.plain),
        token.letterCase,
      );
    } else if (token.kind === 'ordinal') {
      const lower = token.text.toLowerCase();
      if (FIRST_ONLY.has(lower)) {
        // "1er", "1º": the mark belongs to the first of the month only.
        if (originalDay !== 1 || date.day === 1) out += token.text;
      } else {
        out += inCase(englishOrdinal(date.day), letterCaseOf(token.text));
      }
    } else {
      out += token.text;
    }
  }
  return out;
}

function readDay(writing: DateWriting, index: number): number {
  const token = writing.tokens[index];
  return token?.kind === 'num' ? numberOf(token.text) : 0;
}

/** The order a region writes numeric dates in (when the numbers allow both). */
export function regionOrder(region: CountryCode | null): DateOrder {
  if (region === 'US') return 'MDY';
  if (region === 'CN' || region === 'JP' || region === 'KR') return 'YMD';
  return 'DMY';
}

/** A written date read as one calendar date. */
export interface DateReading {
  readonly writing: DateWriting;
  readonly order: DateOrder;
  readonly date: CalendarDate;
  /**
   * True when the numbers allowed two different dates and the region's
   * convention chose one.
   */
  readonly ambiguous: boolean;
  /**
   * True when the numbers allowed more than one order and the region's
   * convention chose this one (even if both read as the same date, as in
   * 05/05/1990: the order still decides how other dates are written).
   */
  readonly byRegion: boolean;
}

export interface DateBounds {
  readonly earliest: CalendarDate;
  readonly latest: CalendarDate;
}

/** Birth dates: from 1 January 1900 to today. */
export function birthDateBounds(today: CalendarDate): DateBounds {
  return { earliest: { year: 1900, month: 1, day: 1 }, latest: today };
}

/**
 * Reads a written date. Readings outside the bounds are dropped; when two
 * different dates remain, the order of `region` (else DMY) decides.
 * Deterministic for the same text, region and day.
 */
export function readDate(
  text: string,
  region: CountryCode | null,
  today: CalendarDate,
  bounds: DateBounds | null = null,
): DateReading | null {
  const writing = parseDateWriting(text);
  if (writing === null) return null;
  const readings: { order: DateOrder; date: CalendarDate }[] = [];
  for (const order of writing.orders) {
    const date = readAs(writing, order, today);
    if (date === null) continue;
    if (
      bounds !== null &&
      (isoDate(date) < isoDate(bounds.earliest) ||
        isoDate(date) > isoDate(bounds.latest))
    ) {
      continue;
    }
    readings.push({ order, date });
  }
  const [first] = readings;
  if (first === undefined) return null;
  const preferred =
    readings.find((reading) => reading.order === regionOrder(region)) ?? first;
  const distinct = new Set(readings.map((reading) => isoDate(reading.date)));
  return {
    writing,
    ...preferred,
    ambiguous: distinct.size > 1,
    byRegion: readings.length > 1,
  };
}

const SEPARATOR_AFTER_DAY = String.raw`(?:\s{1,2}(?:of|de)\s{1,2}|\s{1,2}|[-/])`;
const SEPARATOR_BEFORE_YEAR = String.raw`(?:,?\s{1,2}(?:de|del)\s{1,2}|,?\s{1,2}|[-/])`;
const ORDINAL_MARK = '(?:st|nd|rd|th|er|o|º|°)?';
const MONTH_ALTERNATION = MONTH_SPELLINGS.map((spelling) =>
  spelling.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'),
).join('|');

/**
 * Bounded patterns (no nested quantifiers), so finding dates is linear in
 * the text. Not glued to letters, digits or underscores; a numeric date is
 * not part of a longer dotted or dashed number (a version or an address).
 */
const PATTERNS: readonly RegExp[] = [
  /(?<![\p{L}\p{N}_./-])(?:\d{4}([./-])\d{1,2}\1\d{1,2}|\d{1,2}([./-])\d{1,2}\2(?:\d{4}|\d{2}))(?![\p{L}\p{N}_]|[./-]\d)/gu,
  /(?<!\d)\d{4}\s?[年년]\s?\d{1,2}\s?[月월]\s?\d{1,2}\s?[日일]/gu,
  new RegExp(
    String.raw`(?<![\p{L}\p{N}_])\d{1,2}${ORDINAL_MARK}\.?${SEPARATOR_AFTER_DAY}(?:${MONTH_ALTERNATION})\.?${SEPARATOR_BEFORE_YEAR}(?:\d{4}|\d{2})(?![\p{L}\p{N}_])`,
    'giu',
  ),
  new RegExp(
    String.raw`(?<![\p{L}\p{N}_])(?:${MONTH_ALTERNATION})\.?\s{1,2}\d{1,2}(?:st|nd|rd|th)?,?\s{1,2}\d{4}(?![\p{L}\p{N}_])`,
    'giu',
  ),
];

/** A date-shaped stretch of text, as [start, end) offsets. */
export interface DateSpan {
  readonly start: number;
  readonly end: number;
}

/** Date-shaped stretches of text, left to right, not overlapping. */
export function findDateSpans(text: string): DateSpan[] {
  const found: DateSpan[] = [];
  for (const pattern of PATTERNS) {
    const scan = new RegExp(pattern.source, pattern.flags);
    for (let match = scan.exec(text); match !== null; match = scan.exec(text)) {
      found.push({ start: match.index, end: match.index + match[0].length });
    }
  }
  found.sort((a, b) => a.start - b.start || b.end - a.end);
  const out: DateSpan[] = [];
  let end = 0;
  for (const span of found) {
    if (span.start < end) continue;
    out.push(span);
    end = span.end;
  }
  return out;
}
