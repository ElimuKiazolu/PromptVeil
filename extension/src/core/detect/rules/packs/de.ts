/**
 * Germany pack: tax identification number, Steuer-IdNr (DE_TAXID).
 *
 * Eleven digits (Bundeszentralamt für Steuern; § 139b AO): the first is not
 * 0; among the first ten digits exactly one digit occurs twice or three
 * times and every other digit at most once (three equal digits may not all
 * be adjacent); the eleventh is an ISO 7064 MOD 11,10 check digit. Written
 * plain or as "36 574 261 809". Not the regional Steuernummer, which has a
 * different, state-specific format and is not detected here.
 */
import { isValidMod11_10, mod11_10CheckDigit } from '../../checksum.ts';
import { ID_REFERENCE_BEFORE } from '../negative.ts';
import type { Span } from '../../text.ts';
import { INVALID, finding, type Rule } from '../types.ts';
import type { CountryPack } from './index.ts';

const SPACED = /^(\d{2}) (\d{3}) (\d{3}) (\d{3})$/u;

function taxIdDigits(value: string): string | null {
  if (/^\d{11}$/u.test(value)) return value;
  const spaced = SPACED.exec(value);
  return spaced === null ? null : spaced.slice(1).join('');
}

/** The repetition rule for the first ten digits. */
function hasValidRepetition(first10: string): boolean {
  const counts = new Map<string, number>();
  for (const digit of first10) counts.set(digit, (counts.get(digit) ?? 0) + 1);
  const repeated = [...counts.values()].filter((count) => count > 1);
  if (repeated.length !== 1) return false;
  const [times = 0] = repeated;
  if (times > 3) return false;
  return !/(\d)\1\1/u.test(first10);
}

export function isValidTaxId(value: string): boolean {
  const digits = taxIdDigits(value);
  if (digits === null || digits.startsWith('0')) return false;
  return hasValidRepetition(digits.slice(0, 10)) && isValidMod11_10(digits);
}

function taxIdCheckDigit(payload: string): string | null {
  const check = mod11_10CheckDigit(payload);
  return check === null ? null : check.toString();
}

const TAXID_CANDIDATE =
  /(?<![\p{L}\p{N}_])(?<!\d[ .,-])(?:\d{11}|\d{2} \d{3} \d{3} \d{3})(?![ .,-]?\d)(?![\p{L}\p{N}_])/gu;

function* findTaxIds(text: string): Generator<Span> {
  for (const match of text.matchAll(TAXID_CANDIDATE)) {
    yield { start: match.index, end: match.index + match[0].length };
  }
}

export const DE_TAXID_RULE: Rule = {
  id: 'de.taxid',
  type: 'NATIONAL_ID',
  subtype: 'DE_TAXID',
  country: 'DE',
  find: findTaxIds,
  validate: (value) =>
    isValidTaxId(value) ? finding(DE_TAXID_RULE, 'checksum') : INVALID,
  context: {
    words: [
      'steuer-id',
      'steuer id',
      'steuerid',
      'steuer-idnr',
      'steueridentifikationsnummer',
      'steuerliche identifikationsnummer',
      'identifikationsnummer',
      'idnr',
      'tin',
      'tax id',
    ],
    before: 40,
    after: 16,
  },
  contextRequired: false,
  negativeContext: [ID_REFERENCE_BEFORE],
  confidence: { validated: 1, context: 1, none: 1 },
};

export const DE_PACK: CountryPack = {
  country: 'DE',
  rules: [DE_TAXID_RULE],
  standIns: {
    DE_TAXID: {
      formats: ['###########', '## ### ### ###'],
      checksum: 'iso7064-mod11-10',
      checkCharacters: taxIdCheckDigit,
      isValid: isValidTaxId,
      avoid: [
        'first digit 0',
        'first ten digits: exactly one digit twice or three times (not three adjacent), the rest at most once',
      ],
    },
  },
};
