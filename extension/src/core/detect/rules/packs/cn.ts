/**
 * China pack: Resident Identity Card number (CN_RIC), GB 11643-1999.
 *
 * Eighteen characters: a six-digit administrative division code (GB/T 2260;
 * its first two digits name the province-level division), the birth date
 * YYYYMMDD, a three-digit sequence and an ISO 7064 MOD 11-2 check character
 * (0–9 or X). Written plain or as 6-8-4 groups. The birth date must be a
 * real date between 1900 and today.
 *
 * The legacy 15-digit number of first-generation cards is not detected: it
 * has no check digit (so any 15-digit run with a date in it would match),
 * and first-generation cards stopped being valid on 1 January 2013.
 */
import { isValidMod11_2, mod11_2CheckCharacter } from '../../checksum.ts';
import { ID_REFERENCE_BEFORE } from '../negative.ts';
import type { Span } from '../../text.ts';
import { INVALID, finding, type Rule } from '../types.ts';
import { isCalendarDate, isNotFuture } from './common.ts';
import type { CountryPack } from './index.ts';

/**
 * Province-level codes of GB/T 2260, plus 71 (Taiwan) and 81–83, the codes
 * on residence permits for Hong Kong, Macao and Taiwan residents.
 */
const PROVINCES = new Set(
  '11 12 13 14 15 21 22 23 31 32 33 34 35 36 37 41 42 43 44 45 46 50 51 52 53 54 61 62 63 64 65 71 81 82 83'.split(
    ' ',
  ),
);

const EARLIEST_YEAR = 1900;

/** The 18 characters without separators, upper case, or null. */
function ricCharacters(value: string): string | null {
  const plain = value.replace(/ /gu, '');
  if (plain !== value && !/^\d{6} \d{8} \d{3}[\dXx]$/u.test(value)) return null;
  return /^\d{17}[\dXx]$/u.test(plain) ? plain.toUpperCase() : null;
}

export function isValidRic(value: string, today: Date = new Date()): boolean {
  const ric = ricCharacters(value);
  if (ric === null || !PROVINCES.has(ric.slice(0, 2))) return false;
  const year = Number(ric.slice(6, 10));
  const month = Number(ric.slice(10, 12));
  const day = Number(ric.slice(12, 14));
  if (year < EARLIEST_YEAR || !isCalendarDate(year, month, day)) return false;
  if (!isNotFuture(year, month, day, today)) return false;
  return isValidMod11_2(ric);
}

const RIC_CANDIDATE =
  /(?<![\p{L}\p{N}_])(?<!\d[ .,-])(?:\d{17}[\dXx]|\d{6} \d{8} \d{3}[\dXx])(?![ .,-]?\d)(?![\p{L}\p{N}_])/gu;

function* findRics(text: string): Generator<Span> {
  for (const match of text.matchAll(RIC_CANDIDATE)) {
    yield { start: match.index, end: match.index + match[0].length };
  }
}

export const CN_RIC_RULE: Rule = {
  id: 'cn.ric',
  type: 'NATIONAL_ID',
  subtype: 'CN_RIC',
  country: 'CN',
  find: findRics,
  validate: (value) =>
    isValidRic(value) ? finding(CN_RIC_RULE, 'checksum') : INVALID,
  context: {
    words: [
      '身份证',
      '身份证号',
      '身份证号码',
      '居民身份证',
      '公民身份号码',
      'id card',
      'id number',
      'resident identity card',
      'resident id',
    ],
    before: 40,
    after: 16,
  },
  contextRequired: false,
  negativeContext: [ID_REFERENCE_BEFORE],
  confidence: { validated: 1, context: 1, none: 1 },
};

export const CN_PACK: CountryPack = {
  country: 'CN',
  rules: [CN_RIC_RULE],
  standIns: {
    CN_RIC: {
      formats: ['#################C', '###### ######## ###C'],
      checksum: 'iso7064-mod11-2',
      checkCharacters: mod11_2CheckCharacter,
      isValid: (value) => isValidRic(value),
      avoid: [
        'province codes outside GB/T 2260 (keep the real province or a listed one)',
        'birth dates before 1900, after today or not in the calendar',
      ],
    },
  },
};
