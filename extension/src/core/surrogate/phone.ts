/**
 * PHONE stand-ins (TR-S2): the same calling code, the same national number
 * length and the same way of writing it. Only the national significant
 * number changes; it is always the last digits of the written number, so the
 * prefix as written ("+44", "0044", "+44 (0)", "0" or none) and every space,
 * bracket and hyphen stay as they were.
 *
 * The new number comes from a range reserved for fiction when one fits
 * (same calling code, length and kind of number; for geographic ranges the
 * real number's area first, see fictional-phones.ts). Otherwise it is a
 * random number that libphonenumber accepts as valid, of the same type
 * (mobile, fixed line), keeping the first digit (then the first three) of
 * the real number so the type usually stays the same.
 */
import {
  isSupportedCountry,
  parsePhoneNumberFromString,
  type CountryCode as PhoneRegion,
  type PhoneNumber,
} from 'libphonenumber-js/max';
import {
  FICTIONAL_PHONE_RANGES,
  inFictionalRange,
  isFictionalPhone,
  kindFits,
  type FictionalPhoneRange,
} from '../detect/validators/fictional-phones.ts';
import type { PhoneType } from '../detect/validators/phone.ts';
import { DIGITS, type Rng } from './rng.ts';
import type { Generator } from './types.ts';

/** Random numbers tried before giving up on an attempt. */
const RANDOM_DRAWS = 400;
const SPACES = /[\u00A0\u2007\u2009\u202F]/gu;

function parse(raw: string, region: PhoneRegion | undefined) {
  return parsePhoneNumberFromString(raw.replace(SPACES, ' '), {
    defaultCountry: region,
    extract: false,
  });
}

/** True when both are the same kind of number (mobile, fixed line, ...). */
function sameType(real: PhoneType | null, candidate: PhoneType | undefined) {
  if (real === null) return true;
  if (candidate === undefined) return false;
  if (real === candidate) return true;
  const either = new Set<PhoneType>(['FIXED_LINE', 'MOBILE']);
  return (
    (real === 'FIXED_LINE_OR_MOBILE' && either.has(candidate)) ||
    (candidate === 'FIXED_LINE_OR_MOBILE' && either.has(real))
  );
}

/** Reserved ranges that can stand in for this number, its area's first. */
export function fittingRanges(
  callingCode: string,
  nationalNumber: string,
  type: PhoneType | null,
): FictionalPhoneRange[] {
  const fits = FICTIONAL_PHONE_RANGES.filter(
    (entry) =>
      entry.callingCode === callingCode &&
      entry.pattern.length === nationalNumber.length &&
      kindFits(entry.kind, type),
  );
  const sameArea = fits.filter(
    (entry) => entry.area !== null && nationalNumber.startsWith(entry.area),
  );
  return sameArea.length > 0
    ? sameArea
    : fits.filter((entry) => entry.area === null);
}

function fill(range: FictionalPhoneRange, rng: Rng, real: string): string {
  let out = '';
  for (let i = 0; i < range.pattern.length; i += 1) {
    const slot = range.pattern.charAt(i);
    out +=
      slot === '#' ? rng.char(DIGITS) : slot === 'K' ? real.charAt(i) : slot;
  }
  return out;
}

function randomNumber(rng: Rng, real: PhoneNumber): string | null {
  const national = real.nationalNumber;
  const callingCode = real.countryCallingCode;
  const type = real.getType() ?? null;
  for (let draw = 0; draw < RANDOM_DRAWS; draw += 1) {
    const keep = draw < RANDOM_DRAWS / 2 ? 1 : Math.min(3, national.length - 4);
    const candidate =
      national.slice(0, keep) + rng.chars(DIGITS, national.length - keep);
    if (candidate === national || isFictionalPhone(callingCode, candidate)) {
      continue;
    }
    const parsed = parse(`+${callingCode}${candidate}`, undefined);
    if (parsed?.isValid() && sameType(type, parsed.getType())) {
      return candidate;
    }
  }
  return null;
}

/** The written number with its national significant number replaced. */
function render(
  written: string,
  real: PhoneNumber,
  national: string,
): string | null {
  const digits = written.replace(/\D/gu, '');
  if (digits.endsWith(real.nationalNumber)) {
    // Replace the last digits in place; everything before them stays.
    let remaining = national.length;
    let out = '';
    for (let i = written.length - 1; i >= 0; i -= 1) {
      const char = written.charAt(i);
      if (remaining > 0 && char >= '0' && char <= '9') {
        remaining -= 1;
        out = national.charAt(remaining) + out;
      } else {
        out = char + out;
      }
    }
    return out;
  }
  // Written in a way where the national number is not the trailing digits
  // (e.g. an inserted mobile token): written again by the library instead.
  const next = parse(`+${real.countryCallingCode}${national}`, undefined);
  if (next === undefined) return null;
  return written.trimStart().startsWith('+')
    ? next.formatInternational()
    : next.formatNational();
}

export const phoneStandIn: Generator = ({ request, rng, reservedAllowed }) => {
  const region =
    request.country !== null && isSupportedCountry(request.country)
      ? request.country
      : undefined;
  const real = parse(request.value, region);
  if (!real?.isValid()) return null;
  const type = real.getType() ?? null;
  let national: string | null = null;
  let reserved = false;
  if (reservedAllowed) {
    const ranges = fittingRanges(
      real.countryCallingCode,
      real.nationalNumber,
      type,
    );
    if (ranges.length > 0) {
      national = fill(rng.pick(ranges), rng, real.nationalNumber);
      reserved = true;
    }
  }
  national ??= randomNumber(rng, real);
  if (national === null || national === real.nationalNumber) return null;
  const value = render(request.value, real, national);
  return value === null ? null : { value, reserved };
};

/**
 * Format check for PHONE stand-ins: a possible number (right length) for the
 * region, with a national number as long as the real one's. Numbers from
 * ranges reserved for fiction pass; libphonenumber may not call them valid.
 */
export function isWellFormedPhoneStandIn(
  standIn: string,
  real: string,
  country: string | null,
): boolean {
  const region =
    country !== null && isSupportedCountry(country) ? country : undefined;
  const realNumber = parse(real, region);
  const candidate = parse(standIn, region);
  if (realNumber === undefined || candidate === undefined) return false;
  return (
    candidate.isPossible() &&
    candidate.countryCallingCode === realNumber.countryCallingCode &&
    candidate.nationalNumber.length === realNumber.nationalNumber.length
  );
}

/** True when the number is in a range reserved for fiction. */
export function isReservedPhone(value: string, country: string | null) {
  const region =
    country !== null && isSupportedCountry(country) ? country : undefined;
  const parsed = parse(value, region);
  return (
    parsed !== undefined &&
    FICTIONAL_PHONE_RANGES.some(
      (entry) =>
        entry.callingCode === parsed.countryCallingCode &&
        inFictionalRange(entry, parsed.nationalNumber),
    )
  );
}
