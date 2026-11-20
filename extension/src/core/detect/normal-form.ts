/**
 * The vault normal form of a real value: the form that is hashed to find its
 * mapping, so separator and case variants of one value share one mapping.
 *
 * It lives with the detection code because PHONE needs libphonenumber: the
 * content script computes it with the detection module it already loads and
 * sends it with each value, so the service worker (which owns the vault) does
 * not carry the phone library and its metadata.
 */
import type { CountryCode } from '../../shared/country.ts';
import type { EntitySubtype, EntityType } from '../../shared/entities.ts';
import { normaliseCard } from './validators/card.ts';
import { normaliseCrypto } from './validators/crypto.ts';
import { normaliseEmail } from './validators/email.ts';
import { normaliseIban } from './validators/iban.ts';
import { normaliseIp } from './validators/ip.ts';
import { normalisePhone } from './validators/phone.ts';
import { normaliseSecret } from './validators/secret.ts';
import { TITLES } from '../names/titles.ts';
import { calendarDay, isoDate } from '../dates/calendar.ts';
import { birthDateBounds, readDate } from '../dates/writing.ts';

/** Upper case without spaces, hyphens, dots and slashes. */
function compactUpper(value: string): string {
  return value.toUpperCase().replace(/[\s./-]/gu, '');
}

/** NFC, spaces collapsed, lower case, leading titles removed. */
function normaliseName(value: string): string {
  const collapsed = value
    .normalize('NFC')
    .replace(/\s+/gu, ' ')
    .trim()
    .toLowerCase();
  const stripped = collapsed.replace(TITLES, '');
  return stripped === '' ? collapsed : stripped;
}

/**
 * A date of birth as ISO 8601 (YYYY-MM-DD), so every writing of one date
 * shares a mapping. Day and month are read as the rule read them (the
 * detection's country decides an order the numbers leave open).
 */
function normaliseBirthDate(
  country: CountryCode | null,
  value: string,
): string {
  const today = calendarDay(Date.now());
  const text = value.normalize('NFC').trim();
  const reading =
    readDate(text, country, today, birthDateBounds(today)) ??
    readDate(text, country, today);
  return reading === null ? text : isoDate(reading.date);
}

function normaliseBank(subtype: EntitySubtype | null, value: string): string {
  switch (subtype) {
    case 'IBAN':
      return normaliseIban(value);
    case 'IN_UPI':
      return value.trim().toLowerCase();
    default:
      return compactUpper(value);
  }
}

/**
 * The vault form of a real value (rules per type; types without a rule yet
 * are NFC and trimmed, and get their own rule when their detector lands).
 */
export function normaliseReal(
  type: EntityType,
  subtype: EntitySubtype | null,
  country: CountryCode | null,
  value: string,
): string {
  switch (type) {
    case 'PHONE':
      return normalisePhone(value, country ?? undefined);
    case 'EMAIL':
      return normaliseEmail(value);
    case 'CARD':
      return normaliseCard(value);
    case 'BANK':
      return normaliseBank(subtype, value);
    case 'NATIONAL_ID':
    case 'PASSPORT':
    case 'POSTCODE':
      return compactUpper(value);
    case 'SECRET':
      return normaliseSecret(value);
    case 'CRYPTO':
      return normaliseCrypto(value);
    case 'PERSON':
    case 'ORG':
    case 'ADDRESS':
      return normaliseName(value);
    case 'IP':
      return normaliseIp(value);
    case 'DOB':
      return normaliseBirthDate(country, value);
    case 'DATE':
    case 'CUSTOM':
      return value.normalize('NFC').trim();
  }
}
