import { describe, expect, it } from 'vitest';
import { normaliseReal } from '@/src/core/detect/normal-form.ts';

describe('normaliseReal', () => {
  it('normalises each type as the schema specifies', () => {
    // GB phone: libphonenumber's own GB mobile example number.
    expect(
      normaliseReal('EMAIL', null, null, '  Dana.Whitfield@Example.COM '),
    ).toBe('dana.whitfield@example.com');
    expect(normaliseReal('PHONE', null, 'GB', '07400 123456')).toBe(
      '+447400123456',
    );
    expect(normaliseReal('PHONE', null, null, '+44 7400 123456')).toBe(
      '+447400123456',
    );
    expect(normaliseReal('CARD', null, null, '4242-4242 4242.4242')).toBe(
      '4242424242424242',
    );
    expect(
      normaliseReal('BANK', 'IBAN', 'GB', 'gb82 west 1234 5698 7654 32'),
    ).toBe('GB82WEST12345698765432');
    expect(normaliseReal('BANK', 'IN_UPI', 'IN', ' Name@Bank ')).toBe(
      'name@bank',
    );
    expect(normaliseReal('BANK', 'SWIFT_BIC', null, 'deut de ff')).toBe(
      'DEUTDEFF',
    );
    expect(normaliseReal('NATIONAL_ID', 'BR_CPF', 'BR', '111.444.777-35')).toBe(
      '11144477735',
    );
    expect(
      normaliseReal('NATIONAL_ID', 'CN_RIC', 'CN', '11010519491231002x'),
    ).toBe('11010519491231002X');
    expect(normaliseReal('PASSPORT', null, null, 'ab 123-456')).toBe(
      'AB123456',
    );
    expect(normaliseReal('POSTCODE', null, 'GB', 'sw1a 1aa')).toBe('SW1A1AA');
    expect(normaliseReal('SECRET', null, null, 'AbC-123')).toBe('AbC-123');
    expect(normaliseReal('CRYPTO', null, null, ' 1AbC ')).toBe(' 1AbC ');
    expect(normaliseReal('DATE', null, null, ' 1 May 2020 ')).toBe(
      '1 May 2020',
    );
  });

  it('collapses spaces, lower-cases and strips leading titles from names', () => {
    expect(
      normaliseReal('PERSON', null, null, '  Dr.  Dana   Whitfield '),
    ).toBe('dana whitfield');
    expect(
      normaliseReal('PERSON', null, null, 'Prof. Dr. Dana Whitfield'),
    ).toBe('dana whitfield');
    expect(normaliseReal('PERSON', null, null, 'Mme Dana Whitfield')).toBe(
      'dana whitfield',
    );
    expect(normaliseReal('PERSON', null, null, 'M. Dana Whitfield')).toBe(
      'dana whitfield',
    );
    // A bare initial is not a title; a lone title is kept rather than emptied.
    expect(normaliseReal('PERSON', null, null, 'M Dana')).toBe('m dana');
    expect(normaliseReal('PERSON', null, null, 'Dr')).toBe('dr');
    // NFC: a decomposed é equals the composed one.
    const decomposed = `Cafe${String.fromCodePoint(0x301)} Ltd`;
    const composed = `Caf${String.fromCodePoint(0xe9)} Ltd`;
    expect(normaliseReal('ORG', null, null, decomposed)).toBe(
      normaliseReal('ORG', null, null, composed),
    );
  });
});
