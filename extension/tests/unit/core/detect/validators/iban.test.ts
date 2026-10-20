import { describe, expect, it } from 'vitest';
import { isCountryCode } from '@/src/shared/country.ts';
import {
  IBAN_LENGTHS,
  normaliseIban,
  validateIban,
} from '@/src/core/detect/validators/iban.ts';

// Example IBANs (electronic format) from the SWIFT IBAN Registry entries.
const REGISTRY_EXAMPLES = [
  'AD1200012030200359100100',
  'AE070331234567890123456',
  'AL47212110090000000235698741',
  'AT611904300234573201',
  'AZ21NABZ00000000137010001944',
  'BA391290079401028494',
  'BE68539007547034',
  'BG80BNBG96611020345678',
  'BH67BMAG00001299123456',
  'BR1800360305000010009795493C1',
  'CH9300762011623852957',
  'CR05015202001026284066',
  'CY17002001280000001200527600',
  'CZ6508000000192000145399',
  'DE89370400440532013000',
  'DK5000400440116243',
  'DO28BAGR00000001212453611324',
  'EE382200221020145685',
  'ES9121000418450200051332',
  'FI2112345600000785',
  'FO6264600001631634',
  'FR1420041010050500013M02606',
  'GB29NWBK60161331926819',
  'GE29NB0000000101904917',
  'GI75NWBK000000007099453',
  'GL8964710001000206',
  'GR1601101250000000012300695',
  'GT82TRAJ01020000001210029690',
  'HR1210010051863000160',
  'HU42117730161111101800000000',
  'IE29AIBK93115212345678',
  'IL620108000000099999999',
  'IS140159260076545510730339',
  'IT60X0542811101000000123456',
  'JO94CBJO0010000000000131000302',
  'KW81CBKU0000000000001234560101',
  'KZ86125KZT5004100100',
  'LB62099900000001001901229114',
  'LC55HEMM000100010012001200023015',
  'LI21088100002324013AA',
  'LT121000011101001000',
  'LU280019400644750000',
  'LV80BANK0000435195001',
  'MC5811222000010123456789030',
  'MD24AG000225100013104168',
  'ME25505000012345678951',
  'MK07250120000058984',
  'MR1300020001010000123456753',
  'MT84MALT011000012345MTLCAST001S',
  'MU17BOMM0101101030300200000MUR',
  'NL91ABNA0417164300',
  'NO9386011117947',
  'PK36SCBL0000001123456702',
  'PL61109010140000071219812874',
  'PS92PALS000000000400123456702',
  'PT50000201231234567890154',
  'QA58DOHB00001234567890ABCDEFG',
  'RO49AAAA1B31007593840000',
  'RS35260005601001611379',
  'SA0380000000608010167519',
  'SE4550000000058398257466',
  'SI56263300012039086',
  'SK3112000000198742637541',
  'SM86U0322509800000000270100',
  'TN5910006035183598478831',
  'TR330006100519786457841326',
  'UA213223130000026007233566001',
  'VG96VPVG0000012345678901',
  'XK051212012345678906',
  'BI4210000100010000332045181',
  'BY13NBRB3600900000002Z00AB00',
  'DJ2100010000000154000100186',
  'EG380019000500000000263180002',
  'FK88SC123456789012',
  'HN88CABF00000000000250005469',
  'IQ98NBIQ850123456789012',
  'LY83002048000020100120361',
  'MN121234123456789123',
  'NI45BAPR00000013000003558124',
  'OM810180000001299123456',
  'RU0304452522540817810538091310419',
  'SC18SSCB11010000000000001497USD',
  'SD2129010501234001',
  'SO211000001001000100141',
  'ST68000100010051845310112',
  'SV62CENR00000000000000700025',
  'TL380080012345678910157',
  'VA59001123000012345678',
  'YE15CBYE0001018861234567891234',
];

it('has a registry example for every country in the length table', () => {
  const covered = new Set(REGISTRY_EXAMPLES.map((iban) => iban.slice(0, 2)));
  expect([...covered].sort()).toEqual(Object.keys(IBAN_LENGTHS).sort());
});

/** Print form: groups of four separated by spaces. */
const printForm = (iban: string): string => iban.replace(/(.{4})(?=.)/g, '$1 ');

describe('IBAN_LENGTHS', () => {
  it('lists the 89 registry countries, each a known country code', () => {
    const codes = Object.keys(IBAN_LENGTHS);
    expect(codes).toHaveLength(89);
    expect(codes.every(isCountryCode)).toBe(true);
  });

  it('has lengths between 15 (Norway) and 33 (Russia)', () => {
    const lengths = Object.values(IBAN_LENGTHS);
    expect(Math.min(...lengths)).toBe(15);
    expect(Math.max(...lengths)).toBe(33);
  });
});

describe('validateIban', () => {
  it.each(REGISTRY_EXAMPLES)('accepts the registry example %s', (iban) => {
    expect(validateIban(iban)).toEqual({
      valid: true,
      country: iban.slice(0, 2),
      iban,
    });
  });

  it('accepts the print form, lower case and hyphenated groups', () => {
    expect(validateIban('GB29 NWBK 6016 1331 9268 19')).toMatchObject({
      valid: true,
      iban: 'GB29NWBK60161331926819',
    });
    expect(validateIban('de89 3704 0044 0532 0130 00')).toMatchObject({
      valid: true,
      country: 'DE',
    });
    expect(validateIban('NL91-ABNA-0417-1643-00').valid).toBe(true);
    for (const iban of REGISTRY_EXAMPLES) {
      expect(validateIban(printForm(iban)).valid).toBe(true);
    }
  });

  it('rejects a changed character or swapped neighbours', () => {
    expect(validateIban('GB29NWBK60161331926818').valid).toBe(false);
    expect(validateIban('GB29NWBK60161331926891').valid).toBe(false);
    expect(validateIban('GB28NWBK60161331926819').valid).toBe(false);
    expect(validateIban('DE89370400440532013001').valid).toBe(false);
  });

  it('rejects the wrong length for the country', () => {
    expect(validateIban('GB29NWBK6016133192681').valid).toBe(false);
    expect(validateIban('GB29NWBK601613319268190').valid).toBe(false);
  });

  it('rejects countries outside the registry and non-numeric check digits', () => {
    // US and IN do not use IBANs; ZZ is not a country.
    expect(validateIban('US64SVBKUS6S3300958879').valid).toBe(false);
    expect(validateIban('ZZ29NWBK60161331926819').valid).toBe(false);
    expect(validateIban('GBX9NWBK60161331926819').valid).toBe(false);
  });

  it('rejects mixed or doubled separators, punctuation and empty input', () => {
    expect(validateIban('GB29 NWBK-6016 1331 9268 19').valid).toBe(false);
    expect(validateIban('GB29  NWBK 6016 1331 9268 19').valid).toBe(false);
    expect(validateIban('GB29.NWBK.6016.1331.9268.19').valid).toBe(false);
    expect(validateIban('').valid).toBe(false);
    expect(validateIban('GB').valid).toBe(false);
  });
});

describe('normaliseIban', () => {
  it('upper-cases and removes spaces and hyphens', () => {
    expect(normaliseIban('gb29 nwbk-6016 1331 9268 19')).toBe(
      'GB29NWBK60161331926819',
    );
  });
});
