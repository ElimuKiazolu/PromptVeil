/**
 * Calendar dates (proleptic Gregorian, UTC) shared by the date-of-birth
 * rule, its stand-ins, restoring and the request safety net, and by birth
 * dates inside national IDs.
 */

export interface CalendarDate {
  year: number;
  month: number;
  day: number;
}

const DAY_MS = 86_400_000;

export function toTime(date: CalendarDate): number {
  return Date.UTC(date.year, date.month - 1, date.day);
}

export function fromTime(time: number): CalendarDate {
  const date = new Date(time);
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
  };
}

/** The UTC calendar day of a timestamp. */
export function calendarDay(now: number): CalendarDate {
  return fromTime(now);
}

export function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

export function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
}

/** True for a date that exists (no 31 April, 29 February only in leap years). */
export function isRealDate(year: number, month: number, day: number): boolean {
  return (
    Number.isInteger(year) &&
    Number.isInteger(month) &&
    Number.isInteger(day) &&
    year >= 1 &&
    year <= 9999 &&
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= daysInMonth(year, month)
  );
}

/** Negative, zero or positive as `a` is before, on or after `b`. */
export function compareDates(a: CalendarDate, b: CalendarDate): number {
  return a.year - b.year || a.month - b.month || a.day - b.day;
}

export const sameDate = (a: CalendarDate, b: CalendarDate): boolean =>
  compareDates(a, b) === 0;

export function addDays(date: CalendarDate, days: number): CalendarDate {
  return fromTime(toTime(date) + days * DAY_MS);
}

/**
 * The same day and month in another year; 29 February becomes 28 February
 * in a year without it.
 */
export function withYear(date: CalendarDate, year: number): CalendarDate {
  return {
    year,
    month: date.month,
    day: Math.min(date.day, daysInMonth(year, date.month)),
  };
}

/**
 * Full years from `birth` to `on`. Someone born on 29 February has their
 * birthday on 1 March in years without one.
 */
export function ageOn(birth: CalendarDate, on: CalendarDate): number {
  let age = on.year - birth.year;
  const leapBirthday =
    birth.month === 2 && birth.day === 29 && !isLeapYear(on.year);
  const month = leapBirthday ? 3 : birth.month;
  const day = leapBirthday ? 1 : birth.day;
  if (on.month < month || (on.month === month && on.day < day)) age -= 1;
  return age;
}

/**
 * The full year of a two-digit year that is not in the future: this
 * century when that is not after `today`, else the last one.
 */
export function fullYear(twoDigits: number, today: CalendarDate): number {
  const century = Math.floor(today.year / 100) * 100;
  const recent = century + twoDigits;
  return recent <= today.year ? recent : recent - 100;
}

export function pad(value: number, length: number): string {
  return value.toString().padStart(length, '0');
}

/** ISO 8601 calendar date, YYYY-MM-DD. */
export function isoDate(date: CalendarDate): string {
  return `${pad(date.year, 4)}-${pad(date.month, 2)}-${pad(date.day, 2)}`;
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/u;

export function parseIsoDate(text: string): CalendarDate | null {
  const match = ISO_DATE.exec(text);
  if (match === null) return null;
  const [year, month, day] = [match[1], match[2], match[3]].map(Number);
  if (year === undefined || month === undefined || day === undefined) {
    return null;
  }
  return isRealDate(year, month, day) ? { year, month, day } : null;
}
