/**
 * Canada pack: Social Insurance Number (CA_SIN).
 *
 * Nine digits, 3-3-3 or plain, with a Luhn check digit. The first digit
 * gives the issuing region: 1–7 for regions, 9 for temporary residents
 * (Canada.ca, "Social Insurance Number for temporary residents"). 0 is used
 * for tax numbers the CRA assigns and 8 for business numbers, never for a
 * SIN (Wikipedia, "Social insurance number"; python-stdnum's ca.sin rejects
 * 8 as an invalid component), so both are rejected. Nine plain digits count
 * only with a context word nearby.
 */
import { isValidLuhn, luhnCheckDigit } from '../../checksum.ts';
import { ID_REFERENCE_BEFORE } from '../negative.ts';
import { INVALID, finding, type Rule } from '../types.ts';
import { digitGroupScanner, groupedDigits } from './common.ts';
import type { CountryPack } from './index.ts';

const GROUPS = [3, 3, 3] as const;

export function isValidSin(value: string): boolean {
  const read = groupedDigits(value, GROUPS);
  if (read === null) return false;
  const first = read.digits.charAt(0);
  if (first === '0' || first === '8') return false;
  return isValidLuhn(read.digits);
}

function sinCheckDigit(payload: string): string | null {
  const check = luhnCheckDigit(payload);
  return check === null ? null : check.toString();
}

export const CA_SIN_RULE: Rule = {
  id: 'ca.sin',
  type: 'NATIONAL_ID',
  subtype: 'CA_SIN',
  country: 'CA',
  find: digitGroupScanner(GROUPS),
  validate(value, env) {
    if (!isValidSin(value)) return INVALID;
    const plain = groupedDigits(value, GROUPS)?.plain ?? true;
    if (plain && !env.hasContext) return INVALID;
    return finding(CA_SIN_RULE, 'checksum');
  },
  context: {
    words: [
      'sin',
      'sin number',
      'social insurance',
      'social insurance number',
      'nas',
      "numéro d'assurance sociale",
      'numéro d’assurance sociale',
      "numero d'assurance sociale",
      'assurance sociale',
    ],
    before: 40,
    after: 16,
  },
  contextRequired: false,
  negativeContext: [ID_REFERENCE_BEFORE],
  confidence: { validated: 1, context: 1, none: 1 },
};

export const CA_PACK: CountryPack = {
  country: 'CA',
  rules: [CA_SIN_RULE],
  standIns: {
    CA_SIN: {
      formats: ['### ### ###', '###-###-###', '#########'],
      checksum: 'luhn',
      checkCharacters: sinCheckDigit,
      isValid: isValidSin,
      avoid: [
        'first digit 0 (CRA tax numbers) or 8 (business numbers)',
        'first digit 9 means a temporary resident: keep the real value’s first digit class',
      ],
    },
  },
};
