/**
 * Italy pack: codice fiscale (IT_CF) of a person.
 *
 * Sixteen characters (DM 23 December 1976; Agenzia delle Entrate):
 * three surname and three name letters, the birth year (2 digits), a month
 * letter (A B C D E H L M P R S T), the birth day (01–31, plus 40 for women:
 * 41–71), the birthplace code (a letter and three digits; Z for foreign
 * countries) and a check letter. The check letter: characters in odd
 * positions (1st, 3rd, …) and even positions are converted with two tables,
 * summed, modulo 26, as a letter. Omocodia: when two people would get the
 * same code, digits in the numeric positions are replaced by letters
 * (0–9 → L M N P Q R S T U V), from the right; such codes are valid.
 * Upper case only, as printed. The 11-digit code of companies is a VAT
 * number, not a personal ID, and is not detected here.
 */
import { ID_REFERENCE_BEFORE } from '../negative.ts';
import type { Span } from '../../text.ts';
import { INVALID, finding, type Rule } from '../types.ts';
import type { CountryPack } from './index.ts';

const MONTHS = 'ABCDEHLMPRST';
const OMOCODIA = 'LMNPQRSTUV';
/** Positions (0-based) that hold digits, possibly replaced (omocodia). */
const NUMERIC_POSITIONS = [6, 7, 9, 10, 12, 13, 14];
/** Values of characters in odd positions (1st, 3rd, …): 0–9 then A–Z. */
const ODD_VALUES = [
  1, 0, 5, 7, 9, 13, 15, 17, 19, 21, 1, 0, 5, 7, 9, 13, 15, 17, 19, 21, 2, 4,
  18, 20, 11, 3, 6, 8, 12, 14, 16, 10, 22, 25, 24, 23,
];
const CF_SHAPE =
  /^[A-Z]{6}[\dLMNP-V]{2}[ABCDEHLMPRST][\dLMNP-V]{2}[A-Z][\dLMNP-V]{3}[A-Z]$/u;

function characterIndex(char: string): number {
  const code = char.charCodeAt(0);
  return code <= 57 ? code - 48 : code - 65 + 10;
}

/** The check letter for the first 15 characters, or null. */
export function cfCheckLetter(payload: string): string | null {
  if (!/^[A-Z0-9]{15}$/u.test(payload)) return null;
  let sum = 0;
  for (let i = 0; i < 15; i += 1) {
    const index = characterIndex(payload.charAt(i));
    // Positions 1, 3, … (0-based even) use the odd-position table.
    sum +=
      i % 2 === 0 ? (ODD_VALUES[index] ?? 0) : index < 10 ? index : index - 10;
  }
  return String.fromCharCode(65 + (sum % 26));
}

/** The code with omocodia letters turned back into digits. */
function decodeOmocodia(cf: string): string {
  let out = '';
  for (let i = 0; i < cf.length; i += 1) {
    const char = cf.charAt(i);
    const digit = NUMERIC_POSITIONS.includes(i) ? OMOCODIA.indexOf(char) : -1;
    out += digit === -1 ? char : digit.toString();
  }
  return out;
}

export function isValidCf(value: string): boolean {
  if (!CF_SHAPE.test(value)) return false;
  const decoded = decodeOmocodia(value);
  if (!/^\d{2}$/u.test(decoded.slice(6, 8))) return false;
  if (
    !/^\d{2}$/u.test(decoded.slice(9, 11)) ||
    !/^\d{3}$/u.test(decoded.slice(12, 15))
  ) {
    return false;
  }
  const day = Number(decoded.slice(9, 11));
  const dayOfMonth = day > 40 ? day - 40 : day;
  if (dayOfMonth < 1 || dayOfMonth > 31) return false;
  if (!MONTHS.includes(decoded.charAt(8))) return false;
  return cfCheckLetter(value.slice(0, 15)) === value.charAt(15);
}

const CF_CANDIDATE =
  /(?<![\p{L}\p{N}_])[A-Z]{6}[\dLMNP-V]{2}[ABCDEHLMPRST][\dLMNP-V]{2}[A-Z][\dLMNP-V]{3}[A-Z](?![\p{L}\p{N}_])/gu;

function* findCfs(text: string): Generator<Span> {
  for (const match of text.matchAll(CF_CANDIDATE)) {
    yield { start: match.index, end: match.index + match[0].length };
  }
}

export const IT_CF_RULE: Rule = {
  id: 'it.cf',
  type: 'NATIONAL_ID',
  subtype: 'IT_CF',
  country: 'IT',
  find: findCfs,
  validate: (value) =>
    isValidCf(value) ? finding(IT_CF_RULE, 'checksum') : INVALID,
  context: {
    words: [
      'codice fiscale',
      'cod. fisc.',
      'c.f.',
      'cf',
      'fiscal code',
      'tax code',
      'tessera sanitaria',
    ],
    before: 40,
    after: 16,
  },
  contextRequired: false,
  negativeContext: [ID_REFERENCE_BEFORE],
  confidence: { validated: 1, context: 1, none: 1 },
};

export const IT_PACK: CountryPack = {
  country: 'IT',
  rules: [IT_CF_RULE],
  standIns: {
    IT_CF: {
      formats: ['AAAAAA##A##A###A'],
      checksum: 'pack-specific',
      checkCharacters: cfCheckLetter,
      isValid: isValidCf,
      avoid: [
        'month letters other than A B C D E H L M P R S T',
        'days other than 01–31 and 41–71',
        'keep omocodia letters where the real value has them',
      ],
    },
  },
};
