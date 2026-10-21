import { describe, expect, it } from 'vitest';
import examples from 'libphonenumber-js/examples.mobile.json';
import {
  getCountries,
  getExampleNumber,
  type CountryCode as PhoneRegion,
} from 'libphonenumber-js/max';
import { isCountryCode, type CountryCode } from '@/src/shared/country.ts';
import {
  normalisePhone,
  validatePhone,
} from '@/src/core/detect/validators/phone.ts';

/** libphonenumber's published example mobile number for a region. */
function example(region: PhoneRegion) {
  const phone = getExampleNumber(region, examples);
  if (!phone) throw new Error(`no example number for ${region}`);
  return phone;
}

const REGIONS: readonly (CountryCode & PhoneRegion)[] = [
  'GB',
  'US',
  'IN',
  'DE',
  'FR',
  'BR',
  'ZA',
  'SG',
  'CN',
  'CA',
  'AU',
];

describe('validatePhone: international numbers', () => {
  it.each(REGIONS)(
    'accepts the %s example in international format',
    (region) => {
      const phone = example(region);
      const result = validatePhone(phone.formatInternational(), []);
      expect(result).toMatchObject({
        valid: true,
        international: true,
        ambiguous: false,
        fromHomeRegions: false,
        candidates: [
          {
            country: region,
            callingCode: phone.countryCallingCode,
            nationalNumber: phone.nationalNumber,
            e164: phone.number,
            // Mobile, or fixed-line-or-mobile where the plan does not tell (NANP).
            type: phone.getType(),
          },
        ],
      });
    },
  );

  it('ignores home regions for numbers written with +', () => {
    const result = validatePhone('+44 7400 123456', ['US', 'IN']);
    expect(result).toMatchObject({
      valid: true,
      candidates: [{ country: 'GB', e164: '+447400123456' }],
    });
  });

  it('reports a non-geographic number with a null country', () => {
    expect(validatePhone('+800 1234 5678', [])).toMatchObject({
      valid: true,
      ambiguous: false,
      candidates: [{ country: null, callingCode: '800', type: 'TOLL_FREE' }],
    });
  });

  it('rejects numbers that are only the right length (max metadata)', () => {
    // The Ofcom drama mobile range is not an allocated mobile range.
    expect(validatePhone('+44 7700 900123', []).valid).toBe(false);
    expect(validatePhone('+44 1234', []).valid).toBe(false);
    expect(validatePhone('+999 1234 5678', []).valid).toBe(false);
  });
});

describe('validatePhone: national numbers', () => {
  it.each(REGIONS)(
    'accepts the %s example in national format for that home region',
    (region) => {
      const phone = example(region);
      const result = validatePhone(phone.formatNational(), [region]);
      expect(result).toMatchObject({
        valid: true,
        international: false,
        ambiguous: false,
        fromHomeRegions: true,
        candidates: [{ country: region, e164: phone.number }],
      });
    },
  );

  it('describes the written format for format-preserving stand-ins', () => {
    const result = validatePhone('(201) 555-0123', ['US']);
    expect(result).toMatchObject({
      valid: true,
      template: '(###) ###-####',
      candidates: [{ nationalNumber: '2015550123' }],
    });
    expect(validatePhone('+44 7400 123456', [])).toMatchObject({
      template: '+## #### ######',
    });
  });

  it('keeps the national number as the trailing digits of the input', () => {
    for (const raw of ['07400 123456', '0044 7400 123456', '+44 7400 123456']) {
      const result = validatePhone(raw, ['GB']);
      if (!result.valid) throw new Error(`${raw} should be valid`);
      const digits = raw.replace(/\D/g, '');
      const candidate = result.candidates[0];
      expect(candidate?.e164).toBe('+447400123456');
      expect(digits.endsWith(candidate?.nationalNumber ?? '-')).toBe(true);
    }
  });

  it('reports every home region that accepts the number, in home-region order', () => {
    // Ofcom drama range for London; also a valid fixed-line number in India.
    const result = validatePhone('020 7946 0958', ['GB', 'IN']);
    expect(result).toMatchObject({
      valid: true,
      ambiguous: true,
      fromHomeRegions: true,
      candidates: [
        { country: 'GB', e164: '+442079460958', type: 'FIXED_LINE' },
        { country: 'IN', e164: '+912079460958' },
      ],
    });
    expect(validatePhone('020 7946 0958', ['IN', 'GB'])).toMatchObject({
      candidates: [{ country: 'IN' }, { country: 'GB' }],
    });
  });

  it('merges regions that read the number the same way', () => {
    // Guernsey shares +44 with the UK; a London number stays one candidate.
    const result = validatePhone('020 7946 0958', ['GG', 'GB']);
    expect(result).toMatchObject({
      valid: true,
      ambiguous: false,
      candidates: [{ e164: '+442079460958' }],
    });
  });

  it('falls back to every region when no home region accepts the number', () => {
    const result = validatePhone('07400 123456', ['US']);
    if (!result.valid) throw new Error('should be valid somewhere');
    expect(result.fromHomeRegions).toBe(false);
    expect(result.ambiguous).toBe(true);
    expect(result.candidates.map((c) => c.country)).toContain('GB');
    expect(new Set(result.candidates.map((c) => c.e164)).size).toBe(
      result.candidates.length,
    );
  });

  it('gives the same candidates for the same digits on a repeated lookup', () => {
    const first = validatePhone('07400 123456', []);
    const second = validatePhone('07400-123456', []);
    if (!first.valid || !second.valid) throw new Error('should be valid');
    expect(second.candidates).toEqual(first.candidates);
    expect(second.template).toBe('#####-######');
  });

  it('skips home regions libphonenumber does not support', () => {
    // Antarctica (AQ) has no numbering plan.
    expect(validatePhone('07400 123456', ['AQ', 'GB'])).toMatchObject({
      valid: true,
      fromHomeRegions: true,
      candidates: [{ country: 'GB' }],
    });
  });

  it('rejects numbers no region accepts', () => {
    expect(validatePhone('12', ['GB']).valid).toBe(false);
    expect(validatePhone('0000 000000', ['GB']).valid).toBe(false);
  });
});

describe('validatePhone: input shape', () => {
  it('accepts no-break and thin spaces, dots, slashes and brackets', () => {
    expect(validatePhone('07400\u00A0123456', ['GB']).valid).toBe(true);
    expect(validatePhone('+44\u202F7400\u2009123456', []).valid).toBe(true);
    expect(validatePhone('07400.123.456', ['GB']).valid).toBe(true);
    expect(validatePhone('(0)7400/123456', ['GB']).valid).toBe(true);
  });

  it('rejects letters, extensions, a + after the start and empty input', () => {
    expect(validatePhone('1-800-FLOWERS', ['US']).valid).toBe(false);
    expect(validatePhone('(201) 555-0123 ext. 12', ['US']).valid).toBe(false);
    expect(validatePhone('0+44 7400 123456', ['GB']).valid).toBe(false);
    expect(validatePhone(' +44 7400 123456', ['GB']).valid).toBe(false);
    expect(validatePhone('', ['GB']).valid).toBe(false);
    expect(validatePhone('+', ['GB']).valid).toBe(false);
    expect(validatePhone('()- ', ['GB']).valid).toBe(false);
  });

  it('rejects input longer than any written phone number', () => {
    expect(validatePhone(`+44 7400 123456${' '.repeat(30)}`, []).valid).toBe(
      false,
    );
  });
});

describe('region codes', () => {
  it('maps every libphonenumber region to a country code', () => {
    // AC and TA are parts of Saint Helena (SH) and are mapped to it.
    expect(getCountries().filter((region) => !isCountryCode(region))).toEqual([
      'AC',
      'TA',
    ]);
  });

  it('reports Ascension Island numbers as Saint Helena', () => {
    const phone = example('AC');
    expect(validatePhone(phone.formatInternational(), [])).toMatchObject({
      valid: true,
      candidates: [{ country: 'SH' }],
    });
  });
});

describe('normalisePhone', () => {
  it('returns E.164 for valid numbers', () => {
    expect(normalisePhone('07400 123456', 'GB')).toBe('+447400123456');
    expect(normalisePhone('0044 7400 123456', 'GB')).toBe('+447400123456');
    expect(normalisePhone('+44 7400 123456')).toBe('+447400123456');
    expect(normalisePhone('(201) 555-0123', 'US')).toBe('+12015550123');
  });

  it('falls back to "+" and digits when the number does not parse as valid', () => {
    expect(normalisePhone('07400 123456')).toBe('07400123456');
    expect(normalisePhone('+44 7700 900123')).toBe('+447700900123');
    expect(normalisePhone('07400 123456', 'AQ')).toBe('07400123456');
    expect(normalisePhone('ext 12')).toBe('12');
  });
});
