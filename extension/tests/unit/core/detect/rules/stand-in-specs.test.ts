/**
 * Every pack's stand-in spec splits its validator into format + checksum
 * (isWellFormed, what every stand-in passes) and the issuance rules
 * (isValid adds them; the detector uses isValid).
 */
import { describe, expect, it } from 'vitest';
import {
  luhnCheckDigit,
  mod11_10CheckDigit,
  mod11_2CheckCharacter,
  verhoeffCheckDigit,
} from '@/src/core/detect/checksum.ts';
import { COUNTRY_PACKS } from '@/src/core/detect/rules/packs/index.ts';
import type { EntitySubtype } from '@/src/shared/entities.ts';

const specs = new Map(
  COUNTRY_PACKS.flatMap((pack) => Object.entries(pack.standIns)),
);
const spec = (subtype: EntitySubtype) => {
  const found = specs.get(subtype);
  if (found === undefined) throw new Error(`no spec for ${subtype}`);
  return found;
};

const withCheck = (payload: string, check: number | null) =>
  `${payload}${check?.toString() ?? ''}`;

describe('format and checksum versus issuance rules', () => {
  it.each([
    // Never-issued or reserved values: well formed, not valid.
    ['US_SSN', '666-12-3456'],
    ['US_SSN', '900-12-3456'],
    ['US_SSN', '123-00-4567'],
    ['UK_NINO', 'TN 12 34 56 A'],
    ['UK_NINO', 'QQ123456C'],
    ['UK_NHS', '0000000000'],
    ['CA_SIN', withCheck('04645428', luhnCheckDigit('04645428'))],
    ['BR_CPF', '111.111.111-11'],
    ['IN_AADHAAR', withCheck('12341234123', verhoeffCheckDigit('12341234123'))],
    ['IN_PAN', 'ABCDE0000F'],
    ['DE_TAXID', withCheck('0123456788', mod11_10CheckDigit('0123456788'))],
    // Born in the future (GB 11643 worked example moved to 2099).
    [
      'CN_RIC',
      `11010520991231002${mod11_2CheckCharacter('11010520991231002') ?? ''}`,
    ],
  ] as const)('%s %s', (subtype, value) => {
    expect(spec(subtype).isWellFormed(value)).toBe(true);
    expect(spec(subtype).isValid(value)).toBe(false);
  });

  it('every pack spec has both checks, and valid implies well formed', () => {
    const examples: [EntitySubtype, string][] = [
      ['US_SSN', '536-90-4399'],
      ['UK_NINO', 'AB 12 34 56 C'],
      ['UK_NHS', '943 476 5919'],
      ['CA_SIN', '123-456-782'],
      ['BR_CPF', '390.533.447-05'],
      ['IN_AADHAAR', '2341 2341 2346'],
      ['IN_VID', '2341234123412341'],
      ['IN_PAN', 'ACUPA7085R'],
      ['CN_RIC', '11010519491231002X'],
      ['SG_NRIC', 'S1234567D'],
      ['ZA_ID', '7503305044089'],
      ['ES_DNI', 'X1234567L'],
      ['IT_CF', 'RSSMRA85T10A562S'],
      ['FR_NIR', '2 91 01 75 018 002 68'],
      ['DE_TAXID', '36 574 261 809'],
    ];
    expect(new Set(examples.map(([subtype]) => subtype))).toEqual(
      new Set(specs.keys()),
    );
    for (const [subtype, value] of examples) {
      expect(spec(subtype).isValid(value), value).toBe(true);
      expect(spec(subtype).isWellFormed(value), value).toBe(true);
    }
  });

  it('a wrong check character fails both', () => {
    expect(spec('UK_NHS').isWellFormed('943 476 5918')).toBe(false);
    expect(spec('CA_SIN').isWellFormed('123-456-783')).toBe(false);
    expect(spec('DE_TAXID').isWellFormed('36 574 261 808')).toBe(false);
    expect(spec('CN_RIC').isWellFormed('110105194912310021')).toBe(false);
  });
});
