/**
 * PHONE stand-ins (TR-S2): the same calling code, the same national number
 * length and the same way of writing it. Only the national significant
 * number changes; it is always the last digits of the written number, so the
 * prefix as written ("+44", "0044", "+44 (0)", "0" or none) and every space,
 * bracket and hyphen stay as they were.
 *
 * The new number comes from a range reserved for fiction when one fits
 * (same calling code, length and kind of number; for geographic ranges the
 * real number's area first, see fictional-phones.ts). Otherwise it is an
 * unallocated number (owner, P5.3): one libphonenumber (max metadata) calls
 * possible for the calling code (the right length) but valid in none of its
 * regions, so it is in no range the numbering plan has handed out and no
 * chatbot tool or agent can reach anyone with it. Within a mobile or fixed
 * prefix nearly every number counts as allocated, so the leading digits are
 * drawn too and the stand-in no longer shows the kind of number. Every
 * region has such numbers at its numbers' lengths (at least 2 % of random
 * ones, measured over all 245 regions), so RANDOM_DRAWS practically always
 * finds one. The check runs with the shipped metadata, so a range allocated
 * in a later version is refused from then on (isWellFormedPhoneStandIn).
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
  kindFits,
  type FictionalPhoneRange,
} from '../detect/validators/fictional-phones.ts';
import type { PhoneType } from '../detect/validators/phone.ts';
import { DIGITS, type Rng } from './rng.ts';
import type { Generator } from './types.ts';

/** Random numbers tried before giving up on an attempt. */
const RANDOM_DRAWS = 1000;
const SPACES = /[\u00A0\u2007\u2009\u202F]/gu;

function parse(raw: string, region: PhoneRegion | undefined) {
  return parsePhoneNumberFromString(raw.replace(SPACES, ' '), {
    defaultCountry: region,
    extract: false,
  });
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

/** True when the number is possible for the calling code but valid nowhere. */
function isUnallocated(callingCode: string, national: string): boolean {
  const parsed = parse(`+${callingCode}${national}`, undefined);
  return parsed !== undefined && parsed.isPossible() && !parsed.isValid();
}

/**
 * An unallocated number written like the real one; `fits` checks the
 * written form (a national number starting with 0, say, can read back as
 * another number after a trunk prefix).
 */
function unallocatedNumber(
  rng: Rng,
  real: PhoneNumber,
  fits: (national: string) => boolean,
): string | null {
  const national = real.nationalNumber;
  const callingCode = real.countryCallingCode;
  for (let draw = 0; draw < RANDOM_DRAWS; draw += 1) {
    const candidate = rng.chars(DIGITS, national.length);
    if (
      candidate !== national &&
      isUnallocated(callingCode, candidate) &&
      fits(candidate)
    ) {
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
  national ??= unallocatedNumber(rng, real, (candidate) => {
    const written = render(request.value, real, candidate);
    return (
      written !== null &&
      isWellFormedPhoneStandIn(written, request.value, request.country)
    );
  });
  if (national === null || national === real.nationalNumber) return null;
  const value = render(request.value, real, national);
  return value === null ? null : { value, reserved };
};

/**
 * Format check for PHONE stand-ins: a possible number (right length) for the
 * region, with a national number as long as the real one's, and either from
 * a range reserved for fiction or valid in no region of its calling code
 * (unallocated) under the shipped metadata.
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
    candidate.nationalNumber.length === realNumber.nationalNumber.length &&
    (isReservedPhone(standIn, country) ||
      isUnallocated(candidate.countryCallingCode, candidate.nationalNumber))
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
