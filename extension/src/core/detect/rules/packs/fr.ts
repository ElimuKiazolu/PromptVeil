/**
 * France pack: NIR, the social security number (FR_NIR).
 *
 * Fifteen characters (INSEE, RNIPP): sex (1 or 2; 3, 4, 7, 8 for people
 * being registered and temporary numbers), birth year (2 digits), birth
 * month (01–12; 13 when unknown; 20–42 and 50–99 for fictitious or
 * pseudo-fictitious months), department (01–99, or 2A/2B for Corsica),
 * commune or country code (3 digits, not 000), order number (001–999) and a
 * key (01–97) = 97 − (the first 13 digits mod 97), where Corsica's 2A and 2B
 * count as 19 and 18. Written plain or spaced "1 84 12 76 451 089 46".
 */
import { ID_REFERENCE_BEFORE } from '../negative.ts';
import type { Span } from '../../text.ts';
import { INVALID, finding, type Rule } from '../types.ts';
import type { CountryPack } from './index.ts';

const SEXES = '123478';
const COMPACT = /^[1-478]\d{4}(?:\d{2}|2[AB])\d{6}\d{2}$/u;
const SPACED =
  /^([1-478]) (\d{2}) (\d{2}) (\d{2}|2[AB]) (\d{3}) (\d{3}) (\d{2})$/u;

function compactNir(value: string): string | null {
  const upper = value.toUpperCase();
  if (COMPACT.test(upper)) return upper;
  const spaced = SPACED.exec(upper);
  return spaced === null ? null : spaced.slice(1).join('');
}

function isMonth(month: number): boolean {
  return (
    (month >= 1 && month <= 13) || (month >= 20 && month <= 42) || month >= 50
  );
}

/** The key for the first 13 characters (Corsica's 2A/2B as 19/18), or null. */
export function nirKey(first13: string): string | null {
  const numeric = first13
    .replace(/^(.{5})2A/u, '$119')
    .replace(/^(.{5})2B/u, '$118');
  if (!/^\d{13}$/u.test(numeric)) return null;
  let remainder = 0;
  for (const char of numeric) remainder = (remainder * 10 + Number(char)) % 97;
  return (97 - remainder).toString().padStart(2, '0');
}

export function isValidNir(value: string): boolean {
  const nir = compactNir(value);
  if (nir === null || !SEXES.includes(nir.charAt(0))) return false;
  if (!isMonth(Number(nir.slice(3, 5)))) return false;
  if (nir.slice(5, 7) === '00') return false;
  if (nir.slice(7, 10) === '000' || nir.slice(10, 13) === '000') return false;
  return nirKey(nir.slice(0, 13)) === nir.slice(13);
}

const NIR_CANDIDATE =
  /(?<![\p{L}\p{N}_])(?<!\d[ .,-])(?:[1-478]\d{4}(?:\d{2}|2[ABab])\d{8}|[1-478] \d{2} \d{2} (?:\d{2}|2[ABab]) \d{3} \d{3} \d{2})(?![ .,-]?\d)(?![\p{L}\p{N}_])/gu;

function* findNirs(text: string): Generator<Span> {
  for (const match of text.matchAll(NIR_CANDIDATE)) {
    yield { start: match.index, end: match.index + match[0].length };
  }
}

export const FR_NIR_RULE: Rule = {
  id: 'fr.nir',
  type: 'NATIONAL_ID',
  subtype: 'FR_NIR',
  country: 'FR',
  find: findNirs,
  validate: (value) =>
    isValidNir(value) ? finding(FR_NIR_RULE, 'checksum') : INVALID,
  context: {
    words: [
      'nir',
      'numéro de sécurité sociale',
      'numero de securite sociale',
      'sécurité sociale',
      'n° de sécu',
      'numéro de sécu',
      'sécu',
      'insee',
      'numéro insee',
      'carte vitale',
      'social security number',
    ],
    before: 40,
    after: 16,
  },
  contextRequired: false,
  negativeContext: [ID_REFERENCE_BEFORE],
  confidence: { validated: 1, context: 1, none: 1 },
};

export const FR_PACK: CountryPack = {
  country: 'FR',
  rules: [FR_NIR_RULE],
  standIns: {
    FR_NIR: {
      formats: ['###############', '# ## ## ## ### ### ##', '#####2A########'],
      checksum: 'iso7064-mod97-10',
      checkCharacters: nirKey,
      isValid: isValidNir,
      avoid: [
        'sex digits other than 1, 2, 3, 4, 7, 8 (keep the real one)',
        'months outside 01–13, 20–42, 50–99',
        'department 00; commune or order 000',
      ],
    },
  },
};
