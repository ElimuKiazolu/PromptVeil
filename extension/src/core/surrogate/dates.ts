/**
 * Birth dates inside national IDs are shifted by the conversation's date
 * offset (dateOffsetDays), so a stand-in keeps a plausible age and every
 * date of one conversation moves together. A shift that would land after
 * `notAfter` (the future) or before `notBefore` goes the other way.
 */

export interface CalendarDate {
  year: number;
  month: number;
  day: number;
}

const DAY_MS = 86_400_000;

function toTime(date: CalendarDate): number {
  return Date.UTC(date.year, date.month - 1, date.day);
}

function fromTime(time: number): CalendarDate {
  const date = new Date(time);
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
  };
}

export function shiftDate(
  date: CalendarDate,
  offsetDays: number,
  notAfter: CalendarDate,
  notBefore: CalendarDate,
): CalendarDate {
  const origin = toTime(date);
  const shifted = origin + offsetDays * DAY_MS;
  if (shifted > toTime(notAfter) || shifted < toTime(notBefore)) {
    return fromTime(origin - offsetDays * DAY_MS);
  }
  return fromTime(shifted);
}

/** The UTC calendar day of a timestamp. */
export function calendarDay(now: number): CalendarDate {
  return fromTime(now);
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
