/**
 * Singapore pack: NRIC and FIN (SG_NRIC).
 *
 * A prefix letter, seven digits and a check letter. S and T are NRICs
 * (citizens and permanent residents, born before / from 2000), F and G are
 * FINs issued before 2022 and M is the FIN series introduced on 1 January
 * 2022 (ICA media release). The check letter: digits weighted 2, 7, 6, 5,
 * 4, 3, 2, summed, plus an offset (T and G: 4, M: 3), modulo 11, looked up
 * in the prefix's table. ICA does not publish the algorithm; the S/T and F/G
 * tables are the long-established ones (Ngiam Shih Tung's analysis), the M
 * offset is documented by SAP note 2572734, and the M table (with the index
 * reversed) follows the singapore-nric library. ICA's illustrative example
 * M1234567B does not pass it (nor any other table); no published M number
 * that should pass is known.
 */
import { ID_REFERENCE_BEFORE } from '../negative.ts';
import type { Span } from '../../text.ts';
import { INVALID, finding, type Rule } from '../types.ts';
import type { CountryPack } from './index.ts';

const WEIGHTS = [2, 7, 6, 5, 4, 3, 2];
const ST_LETTERS = 'JZIHGFEDCBA';
const FG_LETTERS = 'XWUTRQPNMLK';
const M_LETTERS = 'KLJNPQRTUWX';

/** The check letter for a prefix and seven digits, or null. */
export function nricCheckLetter(prefix: string, digits: string): string | null {
  if (!/^[STFGM]$/u.test(prefix) || !/^\d{7}$/u.test(digits)) return null;
  let sum = 0;
  for (let i = 0; i < 7; i += 1)
    sum += Number(digits.charAt(i)) * (WEIGHTS[i] ?? 0);
  const offset = prefix === 'T' || prefix === 'G' ? 4 : prefix === 'M' ? 3 : 0;
  const index = (sum + offset) % 11;
  if (prefix === 'S' || prefix === 'T') return ST_LETTERS.charAt(index);
  if (prefix === 'F' || prefix === 'G') return FG_LETTERS.charAt(index);
  return M_LETTERS.charAt(10 - index);
}

export function isValidNric(value: string): boolean {
  const parts = /^([STFGM])(\d{7})([A-Z])$/u.exec(value);
  if (parts === null) return false;
  const [, prefix = '', digits = '', letter = ''] = parts;
  return nricCheckLetter(prefix, digits) === letter;
}

/** Upper case only, as printed. */
const NRIC_CANDIDATE = /(?<![\p{L}\p{N}_])[STFGM]\d{7}[A-Z](?![\p{L}\p{N}_])/gu;

function* findNrics(text: string): Generator<Span> {
  for (const match of text.matchAll(NRIC_CANDIDATE)) {
    yield { start: match.index, end: match.index + match[0].length };
  }
}

export const SG_NRIC_RULE: Rule = {
  id: 'sg.nric',
  type: 'NATIONAL_ID',
  subtype: 'SG_NRIC',
  country: 'SG',
  find: findNrics,
  validate: (value) =>
    isValidNric(value) ? finding(SG_NRIC_RULE, 'checksum') : INVALID,
  context: {
    words: [
      'nric',
      'nric no',
      'fin',
      'fin no',
      'ic',
      'ic number',
      'ic no',
      'identity card',
      'kad pengenalan',
      '身份证',
    ],
    before: 40,
    after: 16,
  },
  contextRequired: false,
  negativeContext: [ID_REFERENCE_BEFORE],
  confidence: { validated: 1, context: 1, none: 1 },
};

export const SG_PACK: CountryPack = {
  country: 'SG',
  rules: [SG_NRIC_RULE],
  standIns: {
    SG_NRIC: {
      formats: ['A#######A'],
      checksum: 'pack-specific',
      checkCharacters: (payload) =>
        nricCheckLetter(payload.charAt(0), payload.slice(1)),
      isValid: isValidNric,
      avoid: [
        'keep the real prefix letter (it encodes NRIC vs FIN and the series)',
      ],
    },
  },
};
