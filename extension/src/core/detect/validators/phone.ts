/**
 * PHONE validation with libphonenumber-js (max metadata: full digit patterns
 * and number types, not just lengths).
 *
 * - Written with "+": validated as an international number; the calling code
 *   fixes it, so the result is never ambiguous (its country can still be
 *   null for non-geographic numbers such as +800).
 * - Written nationally: tried against each home region, in order. If none
 *   accepts it, every supported region is tried.
 *
 * Every region that accepts the number is reported as a candidate, deduplicated
 * by E.164 number. More than one distinct E.164 number means the reading
 * depends on the country, and the result says `ambiguous: true`; this module
 * does not pick one. Choosing (context words, home regions, "possible" in
 * Review mode) belongs to the detector (TR-R3).
 *
 * Input is the candidate text only: digits, spaces (including no-break
 * and thin spaces), dots, hyphens, slashes and brackets, with "+" allowed only
 * first. Letters (vanity numbers, "ext.") are rejected.
 */
import {
  getCountries,
  isSupportedCountry,
  parsePhoneNumberFromString,
  type CountryCode as PhoneRegion,
  type PhoneNumber,
  type PhoneNumberType,
} from 'libphonenumber-js/max';
import { isCountryCode, type CountryCode } from '../../../shared/country.ts';

export type PhoneType = PhoneNumberType;

export interface PhoneCandidate {
  /** Region the number belongs to; null for non-geographic numbers. */
  country: CountryCode | null;
  /** Without "+", e.g. "44". */
  callingCode: string;
  /** National significant number: the trailing digits of the input. */
  nationalNumber: string;
  e164: string;
  /** Mobile, fixed line, toll free, ...; null when the metadata cannot tell. */
  type: PhoneType | null;
}

export type PhoneValidation =
  | { valid: false }
  | {
      valid: true;
      /** True when written with a leading "+". */
      international: boolean;
      /**
       * The input with every digit replaced by "#", e.g. "+## #### ######".
       * With `nationalNumber` (always the last digits), this is what a
       * format-preserving stand-in needs: everything before those digits is
       * prefix (calling code, international or national prefix).
       */
      template: string;
      /** Home-region matches, or (if there were none) all-region matches. */
      candidates: readonly PhoneCandidate[];
      /** True when the candidates are more than one distinct number. */
      ambiguous: boolean;
      /** True when the candidates came from the home regions. */
      fromHomeRegions: boolean;
    };

const MAX_INPUT = 40;
/** All-region results kept for reuse (see allRegionCandidates). */
const ALL_REGION_CACHE_SIZE = 256;
const SPACES = new Set([' ', ' ', ' ', ' ', ' ']);
const PUNCTUATION = new Set(['.', '-', '/', '(', ')']);

/**
 * libphonenumber's region codes that are not ISO 3166-1 codes of their own:
 * Ascension Island and Tristan da Cunha belong to Saint Helena (SH).
 */
const REGION_ALIASES: Partial<Record<PhoneRegion, CountryCode>> = {
  AC: 'SH',
  TA: 'SH',
};

function toCountry(region: PhoneRegion | undefined): CountryCode | null {
  if (region === undefined) return null;
  const alias = REGION_ALIASES[region];
  if (alias !== undefined) return alias;
  return isCountryCode(region) ? region : null;
}

/** Template of the input, or null if it has characters a phone number cannot have. */
function phoneTemplate(raw: string): string | null {
  if (raw.length === 0 || raw.length > MAX_INPUT) return null;
  let template = '';
  let digits = 0;
  for (let i = 0; i < raw.length; i += 1) {
    const char = raw.charAt(i);
    if (char >= '0' && char <= '9') {
      template += '#';
      digits += 1;
    } else if (char === '+' && i === 0) {
      template += '+';
    } else if (SPACES.has(char) || PUNCTUATION.has(char)) {
      template += char;
    } else {
      return null;
    }
  }
  return digits === 0 ? null : template;
}

function candidateOf(phone: PhoneNumber): PhoneCandidate {
  return {
    country: toCountry(phone.country),
    callingCode: phone.countryCallingCode,
    nationalNumber: phone.nationalNumber,
    e164: phone.number,
    type: phone.getType() ?? null,
  };
}

/**
 * The number parsed strictly (no extraction from surrounding text), if valid.
 * libphonenumber does not treat every Unicode space as punctuation, so the
 * accepted spaces are passed on as plain spaces.
 */
function parseValid(
  raw: string,
  region: PhoneRegion | undefined,
): PhoneNumber | null {
  let input = '';
  for (const char of raw) input += SPACES.has(char) ? ' ' : char;
  const phone = parsePhoneNumberFromString(input, {
    defaultCountry: region,
    extract: false,
  });
  return phone?.isValid() ? phone : null;
}

function collect(raw: string, regions: Iterable<PhoneRegion>) {
  const byNumber = new Map<string, PhoneCandidate>();
  for (const region of regions) {
    const phone = parseValid(raw, region);
    if (phone && !byNumber.has(phone.number)) {
      byNumber.set(phone.number, candidateOf(phone));
    }
  }
  return [...byNumber.values()];
}

/**
 * Trying every region costs about 16 ms per number on the target laptop, so
 * results are cached by digit string (the only part the parse depends on
 * once the input passed phoneTemplate), least recently used first out. The
 * pipeline re-checks the same prompt as it changes, so most lookups hit.
 */
const allRegionCache = new Map<string, readonly PhoneCandidate[]>();

function allRegionCandidates(raw: string): readonly PhoneCandidate[] {
  const key = raw.replace(/\D/gu, '');
  const cached = allRegionCache.get(key);
  if (cached !== undefined) {
    allRegionCache.delete(key);
    allRegionCache.set(key, cached);
    return cached;
  }
  const candidates = collect(raw, getCountries());
  allRegionCache.set(key, candidates);
  if (allRegionCache.size > ALL_REGION_CACHE_SIZE) {
    const oldest = allRegionCache.keys().next();
    if (oldest.done !== true) allRegionCache.delete(oldest.value);
  }
  return candidates;
}

function* phoneRegions(
  homeRegions: readonly CountryCode[],
): Generator<PhoneRegion> {
  for (const region of homeRegions) {
    if (isSupportedCountry(region)) yield region;
  }
}

export function validatePhone(
  raw: string,
  homeRegions: readonly CountryCode[],
): PhoneValidation {
  const template = phoneTemplate(raw);
  if (template === null) return { valid: false };

  if (raw.startsWith('+')) {
    const phone = parseValid(raw, undefined);
    if (!phone) return { valid: false };
    return {
      valid: true,
      international: true,
      template,
      candidates: [candidateOf(phone)],
      ambiguous: false,
      fromHomeRegions: false,
    };
  }

  let fromHomeRegions = true;
  let candidates: readonly PhoneCandidate[] = collect(
    raw,
    phoneRegions(homeRegions),
  );
  if (candidates.length === 0) {
    fromHomeRegions = false;
    candidates = allRegionCandidates(raw);
  }
  if (candidates.length === 0) return { valid: false };
  return {
    valid: true,
    international: false,
    template,
    candidates,
    ambiguous: candidates.length > 1,
    fromHomeRegions,
  };
}

/**
 * Vault form: E.164 (`+447700900461`) when the number parses as valid with
 * `region` (or on its own, if written with "+"); otherwise "+" (if present)
 * and the digits, without separators.
 */
export function normalisePhone(raw: string, region?: CountryCode): string {
  const phoneRegion =
    region !== undefined && isSupportedCountry(region) ? region : undefined;
  const phone =
    phoneTemplate(raw) === null ? null : parseValid(raw, phoneRegion);
  if (phone) return phone.number;
  const digits = raw.replace(/\D/gu, '');
  return raw.trimStart().startsWith('+') ? `+${digits}` : digits;
}
