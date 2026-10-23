/**
 * United Kingdom pack: National Insurance number (UK_NINO) and NHS number
 * (UK_NHS).
 *
 * NINO (HMRC National Insurance Manual NIM39110): two prefix letters, six
 * digits, a suffix A–D; written "AB123456C" or "AB 12 34 56 C". Neither
 * prefix letter is D, F, I, Q, U or V; the second is not O; BG, GB, KN, NK,
 * NT, TN and ZZ are never allocated (administrative use). No check digit.
 *
 * NHS number (NHS Data Dictionary): ten digits, 3-3-4 or plain; the last is a
 * modulus 11 check digit over the first nine (weights 10 down to 2): 11 minus
 * the remainder, 11 becomes 0, and 10 means the number is invalid. Ten plain
 * digits count only with a context word nearby (one random run in eleven
 * passes the check).
 */
import { weightedMod11 } from '../../checksum.ts';
import { REFERENCE_BEFORE } from '../negative.ts';
import type { Span } from '../../text.ts';
import { INVALID, finding, type Rule } from '../types.ts';
import { digitGroupScanner, groupedDigits, isRepeatedDigit } from './common.ts';
import type { CountryPack } from './index.ts';

const NOT_PREFIX_LETTER = new Set(['D', 'F', 'I', 'Q', 'U', 'V']);
const RESERVED_PREFIXES = new Set(['BG', 'GB', 'KN', 'NK', 'NT', 'TN', 'ZZ']);
const NINO_COMPACT = /^([A-Z]{2})(\d{6})([A-D])$/u;
const NINO_SPACED = /^([A-Z]{2}) (\d{2}) (\d{2}) (\d{2}) ([A-D])$/u;

/** The NINO without spaces, if written in one of its forms. */
function compactNino(value: string): string | null {
  if (NINO_COMPACT.test(value)) return value;
  const spaced = NINO_SPACED.exec(value);
  return spaced === null ? null : spaced.slice(1).join('');
}

export function isValidNino(value: string): boolean {
  const nino = compactNino(value);
  if (nino === null) return false;
  const first = nino.charAt(0);
  const second = nino.charAt(1);
  if (NOT_PREFIX_LETTER.has(first) || NOT_PREFIX_LETTER.has(second))
    return false;
  if (second === 'O') return false;
  return !RESERVED_PREFIXES.has(nino.slice(0, 2));
}

/**
 * Upper-case only: lower-case runs of this shape are mostly identifiers.
 * Linear: fixed-size parts, each followed by an optional single space.
 */
const NINO_CANDIDATE =
  /(?<![\p{L}\p{N}_])[A-Z]{2} ?\d{2} ?\d{2} ?\d{2} ?[A-D](?![\p{L}\p{N}_])/gu;

function* findNinos(text: string): Generator<Span> {
  for (const match of text.matchAll(NINO_CANDIDATE)) {
    yield { start: match.index, end: match.index + match[0].length };
  }
}

export const UK_NINO_RULE: Rule = {
  id: 'gb.nino',
  type: 'NATIONAL_ID',
  subtype: 'UK_NINO',
  country: 'GB',
  find: findNinos,
  validate: (value) =>
    isValidNino(value) ? finding(UK_NINO_RULE, 'structural') : INVALID,
  context: {
    words: [
      'national insurance',
      'national insurance number',
      'ni number',
      'ni no',
      'nino',
      'nat ins',
      'insurance number',
      'yswiriant gwladol',
      'rhif yswiriant gwladol',
    ],
    before: 40,
    after: 16,
  },
  contextRequired: false,
  negativeContext: [REFERENCE_BEFORE],
  confidence: { validated: 0.95, context: 0.95, none: 0.85 },
};

const NHS_GROUPS = [3, 3, 4] as const;
const NHS_WEIGHTS = [10, 9, 8, 7, 6, 5, 4, 3, 2];

/** NHS check digit for the first nine digits, or null if there is none (10). */
export function nhsCheckDigit(payload: string): string | null {
  const remainder = weightedMod11(payload, NHS_WEIGHTS);
  if (remainder === null) return null;
  const check = 11 - remainder;
  if (check === 10) return null;
  return check === 11 ? '0' : check.toString();
}

export function isValidNhsNumber(value: string): boolean {
  const read = groupedDigits(value, NHS_GROUPS);
  if (read === null || isRepeatedDigit(read.digits)) return false;
  return nhsCheckDigit(read.digits.slice(0, 9)) === read.digits.charAt(9);
}

export const UK_NHS_RULE: Rule = {
  id: 'gb.nhs',
  type: 'NATIONAL_ID',
  subtype: 'UK_NHS',
  country: 'GB',
  find: digitGroupScanner(NHS_GROUPS),
  validate(value, env) {
    if (!isValidNhsNumber(value)) return INVALID;
    const plain = groupedDigits(value, NHS_GROUPS)?.plain ?? true;
    if (plain && !env.hasContext) return INVALID;
    return finding(UK_NHS_RULE, 'checksum');
  },
  context: {
    words: ['nhs', 'nhs number', 'nhs no', 'health service number', 'rhif gig'],
    before: 40,
    after: 16,
  },
  contextRequired: false,
  negativeContext: [REFERENCE_BEFORE],
  confidence: { validated: 1, context: 1, none: 1 },
};

export const GB_PACK: CountryPack = {
  country: 'GB',
  rules: [UK_NINO_RULE, UK_NHS_RULE],
  standIns: {
    UK_NINO: {
      formats: ['AA######A', 'AA ## ## ## A'],
      checksum: null,
      checkCharacters: null,
      isValid: isValidNino,
      avoid: [
        'prefix letters D, F, I, Q, U, V; second letter O',
        'prefixes BG, GB, KN, NK, NT, TN, ZZ',
        'suffix other than A–D',
      ],
    },
    UK_NHS: {
      formats: ['### ### ####', '###-###-####', '##########'],
      checksum: 'weighted-mod11',
      checkCharacters: nhsCheckDigit,
      isValid: isValidNhsNumber,
      avoid: [
        'payloads whose check value is 10',
        'all digits the same',
        '999 000 0000 to 999 999 9999 is the test range (valid, never issued)',
      ],
    },
  },
};
