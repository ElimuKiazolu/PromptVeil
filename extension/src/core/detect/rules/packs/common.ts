/**
 * Helpers shared by the country packs: digit-group scanners and the reading
 * of grouped values.
 */
import type { Span } from '../../text.ts';

/**
 * Scanner for digit groups such as 3-2-4 (SSN), 3-3-4 (NHS) or 3-3-3 (SIN):
 * the groups joined by one kind of separator (space or hyphen) or by none,
 * not glued to letters, other digits or a decimal part.
 *
 * Linear: fixed-size groups and a backreferenced separator, so each start
 * position is tried once.
 */
export function digitGroupScanner(
  groups: readonly number[],
): (text: string) => Generator<Span> {
  const [first = 1, ...rest] = groups;
  const body = rest.map((size) => `\\1\\d{${size.toString()}}`).join('');
  const pattern = new RegExp(
    `(?<![\\p{L}\\p{N}_])(?<!\\d[ .,-])\\d{${first.toString()}}([ -]?)${body.replace('\\1', '')}(?![ .,-]?\\d)(?![\\p{L}\\p{N}_])`,
    'gu',
  );
  return function* scan(text: string): Generator<Span> {
    for (const match of text.matchAll(pattern)) {
      yield { start: match.index, end: match.index + match[0].length };
    }
  };
}

/**
 * The digits of a value written as the given groups with one kind of
 * separator throughout (space or hyphen), or with none; null otherwise.
 */
export function groupedDigits(
  value: string,
  groups: readonly number[],
): { digits: string; plain: boolean } | null {
  const total = groups.reduce((sum, size) => sum + size, 0);
  if (/^\d+$/u.test(value)) {
    return value.length === total ? { digits: value, plain: true } : null;
  }
  for (const separator of [' ', '-']) {
    const parts = value.split(separator);
    if (
      parts.length === groups.length &&
      parts.every(
        (part, index) => part.length === groups[index] && /^\d+$/u.test(part),
      )
    ) {
      return { digits: parts.join(''), plain: false };
    }
  }
  return null;
}

/** True when every digit is the same (0000000000), never a real ID. */
export function isRepeatedDigit(digits: string): boolean {
  return /^(\d)\1*$/u.test(digits);
}

/** True for a real calendar date (proleptic Gregorian, years 1–9999). */
export function isCalendarDate(
  year: number,
  month: number,
  day: number,
): boolean {
  if (!Number.isInteger(year) || month < 1 || month > 12 || day < 1)
    return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

/** True when the date is not after `today` (UTC calendar days). */
export function isNotFuture(
  year: number,
  month: number,
  day: number,
  today: Date,
): boolean {
  return (
    Date.UTC(year, month - 1, day) <=
    Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate())
  );
}
