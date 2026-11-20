/**
 * Date-of-birth stand-ins (owner, age-preserving shift): the real date moved
 * by the conversation's date offset; if that changes the age on the day of
 * masking, the year moves by one to restore it (29 February becomes
 * 28 February in a year without it). The stand-in is written exactly like
 * the real date and read in the same day/month order, which is stored with
 * the mapping (its single variant) so replies are read the same way.
 *
 * Attempt n moves n days further. A date that would leave 1900 to today, or
 * equal the real date, goes the other way; if neither fits, the attempt has
 * none.
 */
import {
  addDays,
  ageOn,
  calendarDay,
  compareDates,
  isoDate,
  sameDate,
  withYear,
  type CalendarDate,
} from '../dates/calendar.ts';
import {
  birthDateBounds,
  parseDateWriting,
  readAs,
  readDate,
  writeAs,
  type DateReading,
} from '../dates/writing.ts';
import type { Generator, StandInRequest } from './types.ts';

/** The real date of birth as the rule read it, or null. */
function realReading(request: StandInRequest): DateReading | null {
  const today = calendarDay(request.now);
  return readDate(
    request.value,
    request.country,
    today,
    birthDateBounds(today),
  );
}

/** The stand-in date for an attempt, or null when none fits. */
export function birthDateStandIn(
  real: CalendarDate,
  offsetDays: number,
  attempt: number,
  today: CalendarDate,
): CalendarDate | null {
  const age = ageOn(real, today);
  const { earliest, latest } = birthDateBounds(today);
  const sign = offsetDays < 0 ? -1 : 1;
  const distance = Math.abs(offsetDays) + attempt;
  for (const direction of [sign, -sign]) {
    let candidate = addDays(real, direction * distance);
    // Every move is a year, so two steps cover any shift up to two years.
    for (let step = 0; step < 3; step += 1) {
      const candidateAge = ageOn(candidate, today);
      if (candidateAge === age) break;
      candidate = withYear(
        candidate,
        candidate.year + (candidateAge > age ? 1 : -1),
      );
    }
    if (
      ageOn(candidate, today) === age &&
      !sameDate(candidate, real) &&
      compareDates(candidate, earliest) >= 0 &&
      compareDates(candidate, latest) <= 0
    ) {
      return candidate;
    }
  }
  return null;
}

export const dobStandIn: Generator = ({ request, attempt }) => {
  const reading = realReading(request);
  if (reading === null) return null;
  const today = calendarDay(request.now);
  const date = birthDateStandIn(
    reading.date,
    request.dateOffsetDays,
    attempt,
    today,
  );
  if (date === null) return null;
  const value = writeAs(reading.writing, reading.order, date);
  if (value === null) return null;
  return {
    value,
    reserved: false,
    normalised: isoDate(date),
    parts: [reading.order],
  };
};

/**
 * Written like the real date (same pieces in the same places), and a real
 * date from 1900 to today when read in the real date's order.
 */
export function isWellFormedDobStandIn(
  standIn: string,
  request: StandInRequest,
): boolean {
  const real = realReading(request);
  const writing = parseDateWriting(standIn);
  if (real === null || writing === null) return false;
  // An ordinal mark may come and go with the day (1er, 5).
  const shape = (tokens: typeof writing.tokens): string =>
    tokens
      .filter((token) => token.kind !== 'ordinal')
      .map((token) => (token.kind === 'lit' ? `lit:${token.text}` : token.kind))
      .join('|');
  if (shape(writing.tokens) !== shape(real.writing.tokens)) return false;
  const today = calendarDay(request.now);
  const date = readAs(writing, real.order, today);
  if (date === null) return false;
  const { earliest, latest } = birthDateBounds(today);
  return (
    compareDates(date, earliest) >= 0 &&
    compareDates(date, latest) <= 0 &&
    !sameDate(date, real.date)
  );
}
