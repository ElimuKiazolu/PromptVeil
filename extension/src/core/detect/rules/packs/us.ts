/**
 * United States pack: Social Security number (US_SSN).
 *
 * Format AAA-GG-SSSS (area, group, serial), also with spaces or none. Since
 * SSN randomisation (2011) only these rules are left (SSA): the area is never
 * 000, 666 or 900–999, the group never 00 and the serial never 0000. Two
 * numbers the SSA voided after they were printed publicly are rejected too:
 * 078-05-1120 (a sample card sold in wallets) and 219-09-9999 (a 1940 SSA
 * pamphlet). There is no check digit, so nine plain digits count only with
 * a context word nearby.
 */
import { REFERENCE_BEFORE } from '../negative.ts';
import { INVALID, finding, type Rule } from '../types.ts';
import { digitGroupScanner, groupedDigits } from './common.ts';
import type { CountryPack } from './index.ts';

const GROUPS = [3, 2, 4] as const;

/** Voided by the SSA after public use; never valid. */
const VOIDED = new Set(['078051120', '219099999']);

/** True for a valid SSN in one of its written forms. */
export function isValidSsn(value: string): boolean {
  const read = groupedDigits(value, GROUPS);
  if (read === null) return false;
  const { digits } = read;
  const area = Number(digits.slice(0, 3));
  const group = digits.slice(3, 5);
  const serial = digits.slice(5);
  if (area === 0 || area === 666 || area >= 900) return false;
  if (group === '00' || serial === '0000') return false;
  return !VOIDED.has(digits);
}

export const US_SSN_RULE: Rule = {
  id: 'us.ssn',
  type: 'NATIONAL_ID',
  subtype: 'US_SSN',
  country: 'US',
  find: digitGroupScanner(GROUPS),
  validate(value, env) {
    if (!isValidSsn(value)) return INVALID;
    const plain = groupedDigits(value, GROUPS)?.plain ?? true;
    if (plain && !env.hasContext) return INVALID;
    return finding(US_SSN_RULE, 'structural');
  },
  context: {
    words: [
      'ssn',
      'ss#',
      'ss no',
      'social security',
      'social security number',
      'soc sec',
      'número de seguro social',
      'numero de seguro social',
      'seguro social',
    ],
    before: 40,
    after: 16,
  },
  contextRequired: false,
  negativeContext: [REFERENCE_BEFORE],
  confidence: { validated: 0.95, context: 0.95, none: 0.85 },
};

export const US_PACK: CountryPack = {
  country: 'US',
  rules: [US_SSN_RULE],
  standIns: {
    US_SSN: {
      formats: ['###-##-####', '### ## ####', '#########'],
      checksum: null,
      checkCharacters: null,
      isValid: isValidSsn,
      avoid: [
        'area 000, 666 and 900–999',
        'group 00',
        'serial 0000',
        '078-05-1120 and 219-09-9999 (voided by the SSA)',
        '987-65-4320 to 987-65-4329 (SSA advertising range; area 9xx)',
      ],
    },
  },
};
