/**
 * The forms of a masked real value the request safety net looks for: compact
 * forms (see compact.ts) that every common writing of the value contains.
 *
 * - PHONE: the national significant number. Every written form of a number
 *   ends with it ("07400 123456", "+44 7400 123456", "0044 7400 123456" all
 *   contain 7400123456), so a request carrying the number in any of them is
 *   caught. It is the E.164 normal form without its calling code.
 * - IP: the compact forms of the address as written, in its normal form and,
 *   for IPv6, written out in full, so a request that writes the address
 *   another way is caught too.
 * - DOB: the compact form as written, the date's digits in the three orders
 *   with a 4-digit year
 *   (19900312, 12031990, 03121990) and its English written forms, day or
 *   month first, full or 3-letter month, day with or without padding or an
 *   ordinal (12march1990, march121990, 12thmar1990, ...). Dates written
 *   with month names in other languages are not covered.
 * - Every other type: the compact form of the value as written.
 *
 * Forms shorter than MIN_FORM_LENGTH are left out.
 */
import type { EntityType } from '../../shared/entities.ts';
import { CALLING_CODES } from './calling-codes.ts';
import { compactForm, MIN_FORM_LENGTH } from './compact.ts';
import { expandIpv6, parseIpv6 } from '../detect/validators/ip.ts';
import { pad, parseIsoDate } from '../dates/calendar.ts';
import { monthName } from '../dates/months.ts';

function nationalNumber(normalised: string): string {
  const digits = normalised.replace(/\D/gu, '');
  if (!normalised.startsWith('+')) return digits;
  // The calling codes are prefix-free: at most one matches.
  const code = CALLING_CODES.find((entry) => digits.startsWith(entry));
  return code === undefined ? digits : digits.slice(code.length);
}

/** The IP address's writings that a request could carry. */
function ipForms(real: string, normalised: string): string[] {
  const forms = [real, normalised];
  const v6 = normalised.includes(':') ? parseIpv6(normalised) : null;
  if (v6 !== null) forms.push(expandIpv6(v6));
  return forms.map(compactForm);
}

function englishOrdinal(day: number): string {
  if (day >= 11 && day <= 13) return 'th';
  return ['th', 'st', 'nd', 'rd'][day % 10] ?? 'th';
}

/** The date of birth's digit orders and English written forms. */
function birthDateForms(real: string, normalised: string): string[] {
  const date = parseIsoDate(normalised);
  if (date === null) return [compactForm(real)];
  const year = pad(date.year, 4);
  const month = pad(date.month, 2);
  const day = pad(date.day, 2);
  // The writing it was found in too (e.g. with a German month name).
  const forms = [
    compactForm(real),
    year + month + day,
    day + month + year,
    month + day + year,
  ];
  const days = [
    day,
    String(date.day),
    String(date.day) + englishOrdinal(date.day),
  ];
  for (const form of ['full', 'abbr'] as const) {
    const name = monthName('en', date.month, form, false);
    for (const written of days) {
      forms.push(written + name + year, name + written + year);
    }
  }
  return forms;
}

export function netForms(
  type: EntityType,
  real: string,
  normalised: string,
): string[] {
  const forms =
    type === 'PHONE'
      ? [nationalNumber(normalised)]
      : type === 'IP'
        ? ipForms(real, normalised)
        : type === 'DOB'
          ? birthDateForms(real, normalised)
          : [compactForm(real)];
  return [...new Set(forms)].filter((form) => form.length >= MIN_FORM_LENGTH);
}
