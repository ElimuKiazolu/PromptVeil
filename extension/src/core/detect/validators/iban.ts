/**
 * IBAN validation (ISO 13616): a registry country code, two check digits,
 * the country's fixed length, and remainder 1 under MOD 97-10 after moving
 * the first four characters to the end.
 *
 * Accepts the electronic form and the print form (groups of four separated by
 * single spaces), in either case. Hyphens are accepted the same way, since
 * people paste them; the vault form removes both.
 */
import { isCountryCode, type CountryCode } from '../../../shared/country.ts';
import { mod97 } from '../checksum.ts';
import { stripGroupSeparators } from './separators.ts';

/**
 * IBAN length per country, from the SWIFT IBAN Registry (release 103,
 * September 2026; 89 countries). Territories that use another country's
 * IBAN (e.g. Åland → FI, Jersey → GB, French overseas departments → FR) are
 * covered by that country's code.
 */
export const IBAN_LENGTHS: Readonly<Partial<Record<CountryCode, number>>> = {
  AD: 24,
  AE: 23,
  AL: 28,
  AT: 20,
  AZ: 28,
  BA: 20,
  BE: 16,
  BG: 22,
  BH: 22,
  BI: 27,
  BR: 29,
  BY: 28,
  CH: 21,
  CR: 22,
  CY: 28,
  CZ: 24,
  DE: 22,
  DJ: 27,
  DK: 18,
  DO: 28,
  EE: 20,
  EG: 29,
  ES: 24,
  FI: 18,
  FK: 18,
  FO: 18,
  FR: 27,
  GB: 22,
  GE: 22,
  GI: 23,
  GL: 18,
  GR: 27,
  GT: 28,
  HN: 28,
  HR: 21,
  HU: 28,
  IE: 22,
  IL: 23,
  IQ: 23,
  IS: 26,
  IT: 27,
  JO: 30,
  KW: 30,
  KZ: 20,
  LB: 28,
  LC: 32,
  LI: 21,
  LT: 20,
  LU: 20,
  LV: 21,
  LY: 25,
  MC: 27,
  MD: 24,
  ME: 22,
  MK: 19,
  MN: 20,
  MR: 27,
  MT: 31,
  MU: 30,
  NI: 28,
  NL: 18,
  NO: 15,
  OM: 23,
  PK: 24,
  PL: 28,
  PS: 29,
  PT: 25,
  QA: 29,
  RO: 24,
  RS: 22,
  RU: 33,
  SA: 24,
  SC: 31,
  SD: 18,
  SE: 24,
  SI: 19,
  SK: 24,
  SM: 27,
  SO: 23,
  ST: 25,
  SV: 28,
  TL: 23,
  TN: 24,
  TR: 26,
  UA: 29,
  VA: 22,
  VG: 24,
  XK: 20,
  YE: 30,
};

export type IbanValidation =
  { valid: true; country: CountryCode; iban: string } | { valid: false };

const ALPHANUMERIC = /^[A-Z0-9]+$/;

export function validateIban(value: string): IbanValidation {
  const compact = stripGroupSeparators(value.toUpperCase(), [' ', '-']);
  if (compact === null || !ALPHANUMERIC.test(compact)) return { valid: false };
  const country = compact.slice(0, 2);
  if (!isCountryCode(country)) return { valid: false };
  const length = IBAN_LENGTHS[country];
  if (length === undefined || compact.length !== length) {
    return { valid: false };
  }
  if (!/^\d\d$/.test(compact.slice(2, 4))) return { valid: false };
  const rearranged = compact.slice(4) + compact.slice(0, 4);
  if (mod97(rearranged) !== 1) return { valid: false };
  return { valid: true, country, iban: compact };
}

/** Vault form: upper case, spaces and hyphens removed. */
export function normaliseIban(value: string): string {
  return value.toUpperCase().replace(/[\s-]/gu, '');
}
