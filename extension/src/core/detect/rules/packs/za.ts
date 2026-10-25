/**
 * South Africa pack: identity number (ZA_ID).
 *
 * Thirteen digits YYMMDD SSSS C A Z: the birth date, a sequence number
 * (0000–4999 female, 5000–9999 male), the citizenship digit (0 citizen,
 * 1 permanent resident, 2 refugee), a digit that is now random (formerly
 * race) and a Luhn check digit (Wikipedia, "South African identity card";
 * Department of Home Affairs, identity documents). Written plain, or with
 * a space after the date ("750330 5044089") or as 6-4-2-1 groups
 * ("750330 5044 08 9"). The birth date must be a real date, in 1900–1999
 * or in 2000 up to today.
 */
import { isValidLuhn, luhnCheckDigit } from '../../checksum.ts';
import { ID_REFERENCE_BEFORE } from '../negative.ts';
import type { Span } from '../../text.ts';
import { INVALID, finding, type Rule } from '../types.ts';
import { isCalendarDate, isNotFuture } from './common.ts';
import type { CountryPack } from './index.ts';

const WRITTEN = [/^\d{13}$/u, /^\d{6} \d{7}$/u, /^\d{6} \d{4} \d{2} \d$/u];

function idDigits(value: string): string | null {
  return WRITTEN.some((form) => form.test(value))
    ? value.replace(/ /gu, '')
    : null;
}

/** True when YYMMDD is a real birth date in either century, not in the future. */
function isBirthDate(digits: string, today: Date): boolean {
  const yy = Number(digits.slice(0, 2));
  const month = Number(digits.slice(2, 4));
  const day = Number(digits.slice(4, 6));
  return [2000 + yy, 1900 + yy].some(
    (year) =>
      isCalendarDate(year, month, day) && isNotFuture(year, month, day, today),
  );
}

export function isValidZaId(value: string, today: Date = new Date()): boolean {
  const digits = idDigits(value);
  if (digits === null || !isBirthDate(digits, today)) return false;
  if (!'012'.includes(digits.charAt(10))) return false;
  return isValidLuhn(digits);
}

const ZA_CANDIDATE =
  /(?<![\p{L}\p{N}_])(?<!\d[ .,-])(?:\d{13}|\d{6} \d{7}|\d{6} \d{4} \d{2} \d)(?![ .,-]?\d)(?![\p{L}\p{N}_])/gu;

function* findZaIds(text: string): Generator<Span> {
  for (const match of text.matchAll(ZA_CANDIDATE)) {
    yield { start: match.index, end: match.index + match[0].length };
  }
}

function zaCheckDigit(payload: string): string | null {
  const check = luhnCheckDigit(payload);
  return check === null ? null : check.toString();
}

export const ZA_ID_RULE: Rule = {
  id: 'za.id',
  type: 'NATIONAL_ID',
  subtype: 'ZA_ID',
  country: 'ZA',
  find: findZaIds,
  validate: (value) =>
    isValidZaId(value) ? finding(ZA_ID_RULE, 'checksum') : INVALID,
  context: {
    words: [
      'id number',
      'id no',
      'identity number',
      'sa id',
      'rsa id',
      'id-nommer',
      'id nommer',
      'identiteitsnommer',
      'identiteitsdokument',
    ],
    before: 40,
    after: 16,
  },
  contextRequired: false,
  negativeContext: [ID_REFERENCE_BEFORE],
  confidence: { validated: 1, context: 1, none: 1 },
};

export const ZA_PACK: CountryPack = {
  country: 'ZA',
  rules: [ZA_ID_RULE],
  standIns: {
    ZA_ID: {
      formats: ['#############', '###### #######', '###### #### ## #'],
      checksum: 'luhn',
      checkCharacters: zaCheckDigit,
      isValid: (value) => isValidZaId(value),
      avoid: [
        'birth dates that are not real or in the future',
        'citizenship digit other than 0, 1, 2 (keep the real one)',
      ],
    },
  },
};
