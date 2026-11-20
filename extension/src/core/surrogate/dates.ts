/**
 * Birth dates inside national IDs are shifted by the conversation's date
 * offset (dateOffsetDays), so a stand-in keeps a plausible age and every
 * date of one conversation moves together. A shift that would land after
 * `notAfter` (the future) or before `notBefore` goes the other way.
 */
import { addDays, compareDates, type CalendarDate } from '../dates/calendar.ts';

export {
  calendarDay,
  fullYear,
  pad,
  type CalendarDate,
} from '../dates/calendar.ts';

export function shiftDate(
  date: CalendarDate,
  offsetDays: number,
  notAfter: CalendarDate,
  notBefore: CalendarDate,
): CalendarDate {
  const shifted = addDays(date, offsetDays);
  if (
    compareDates(shifted, notAfter) > 0 ||
    compareDates(shifted, notBefore) < 0
  ) {
    return addDays(date, -offsetDays);
  }
  return shifted;
}
