/**
 * Stand-ins rewritten by a reply (TR-X2). Real values are fixture or
 * published example values (tests/fixtures/identities.json, libphonenumber's
 * example numbers, the IBAN registry's GB example, Stripe test cards); the
 * stand-ins are strings only, never checked here.
 */
import metadata from 'libphonenumber-js/metadata.max.json';
import { Metadata } from 'libphonenumber-js/core';
import { describe, expect, it } from 'vitest';
import { SECRET_TOKENS } from '../detect/rules/secret-tokens.ts';
import type { EntityType } from '@/src/shared/entities.ts';
import { createRestoreMatcher } from '@/src/core/restore/matcher.ts';
import {
  INTERNATIONAL_PREFIXES,
  nationalPrefix,
} from '@/src/core/restore/phone-prefixes.ts';
import type { StandInMapping } from '@/src/core/restore/types.ts';
import { transferLayout, variantsFor } from '@/src/core/restore/variants.ts';

function mapping(
  type: EntityType,
  standIn: string,
  real: string,
  normalised = real,
): StandInMapping {
  return {
    standIn,
    real,
    boundary: type === 'EMAIL' ? 'email' : 'word',
    variants: variantsFor(type, standIn, normalised),
  };
}

const phone = (standIn: string, real: string): StandInMapping =>
  mapping('PHONE', standIn, real, `+${real.replace(/\D/gu, '')}`);

/** Applies replacements the way the restorer does. */
function restore(mappings: StandInMapping[], text: string): string {
  let out = '';
  let cursor = 0;
  for (const r of createRestoreMatcher(mappings).find(text)) {
    out += text.slice(cursor, r.start) + r.real;
    cursor = r.end;
  }
  return out + text.slice(cursor);
}

const NBSP = String.fromCharCode(0xa0);

const IBAN = mapping(
  'BANK',
  'GB82 WEST 1234 5698 7654 32',
  'GB29 NWBK 6016 1331 9268 19',
);
const NINO = mapping('NATIONAL_ID', 'QQ 12 34 56 A', 'AB 12 34 56 C');
const CPF = mapping('NATIONAL_ID', '111.444.777-35', '390.533.447-05');
const CARD = mapping('CARD', '4242 4242 4242 4242', '4111 1111 1111 1111');

describe('variantsFor', () => {
  it('gives number-like types a layout variant', () => {
    expect(IBAN.variants).toEqual({ kind: 'layout', card: false });
    expect(CARD.variants).toEqual({ kind: 'layout', card: true });
    expect(NINO.variants).toEqual({ kind: 'layout', card: false });
  });

  it('gives phones their national significant numbers', () => {
    expect(phone('+44 7400 123456', '+44 7700 900123').variants).toEqual({
      kind: 'phone',
      callingCode: '44',
      standInNumber: '7400123456',
      realNumber: '7700900123',
    });
    // The number is the last digits as written, whatever the prefix.
    expect(
      mapping('PHONE', '07400 123456', '07700 900123', '+447700900123')
        .variants,
    ).toMatchObject({ standInNumber: '7400123456' });
  });

  it('gives nothing to other types, short values or unusual spellings', () => {
    expect(
      variantsFor('EMAIL', 'standin.1@example.net', 'a@example.com'),
    ).toBeUndefined();
    expect(
      variantsFor('SECRET', SECRET_TOKENS.AWS_ACCESS_KEY ?? '', 'x'),
    ).toBeUndefined();
    // Fewer than six letters and digits.
    expect(variantsFor('NATIONAL_ID', '12-345', '67-890')).toBeUndefined();
    expect(variantsFor('PHONE', '12345', '+4412345')).toBeUndefined();
    // Characters the patterns cannot spell, or four separators in a row.
    expect(variantsFor('NATIONAL_ID', '123/456/789', '1')).toBeUndefined();
    expect(variantsFor('CARD', '4242 -  4242', '1')).toBeUndefined();
    // Not an E.164 normal form.
    expect(variantsFor('PHONE', '07400 123456', '07700900123')).toBeUndefined();
  });
});

describe('transferLayout', () => {
  it('keeps the separators and letter case of the shown text', () => {
    expect(transferLayout('qq-12-34', Array.from('AB5678'))).toBe('ab-56-78');
    expect(transferLayout('Qq 12', Array.from('ab34'))).toBe('Ab 34');
  });

  it('is null when the lengths differ', () => {
    expect(transferLayout('12 34', Array.from('12345'))).toBeNull();
    expect(transferLayout('12 345', Array.from('1234'))).toBeNull();
  });
});

describe('number-like values in another layout', () => {
  it.each([
    ['gb82west12345698765432', 'gb29nwbk60161331926819'],
    ['GB82-WEST-1234-5698-7654-32', 'GB29-NWBK-6016-1331-9268-19'],
    ['GB82WEST 12345698 765432', 'GB29NWBK 60161331 926819'],
    ['GB82 WEST 1234 5698 7654 32', 'GB29 NWBK 6016 1331 9268 19'],
  ])('IBAN %s', (shown, real) => {
    expect(restore([IBAN], `IBAN: ${shown}.`)).toBe(`IBAN: ${real}.`);
  });

  it.each([
    ['qq123456a', 'ab123456c'],
    ['QQ-12-34-56-A', 'AB-12-34-56-C'],
    ['QQ 123456 A', 'AB 123456 C'],
    [
      `QQ${NBSP}12${NBSP}34${NBSP}56${NBSP}A`,
      `AB${NBSP}12${NBSP}34${NBSP}56${NBSP}C`,
    ],
  ])('NINO %s', (shown, real) => {
    expect(restore([NINO], `NI number ${shown}`)).toBe(`NI number ${real}`);
  });

  it.each([
    ['11144477735', '39053344705'],
    ['111 444 777 35', '390 533 447 05'],
    ['111.444.777-35', '390.533.447-05'],
  ])('CPF %s', (shown, real) => {
    expect(restore([CPF], `CPF ${shown}`)).toBe(`CPF ${real}`);
  });

  it('restores cards with other separators', () => {
    expect(restore([CARD], 'Card 4242-4242-4242-4242 is on file')).toBe(
      'Card 4111-1111-1111-1111 is on file',
    );
    expect(restore([CARD], '4242424242424242')).toBe('4111111111111111');
  });

  it('leaves values glued to other letters, digits or numbers alone', () => {
    for (const text of [
      'x4242-4242-4242-4242',
      '4242-4242-4242-42421',
      '9-4242-4242-4242-4242',
      '4242-4242-4242-4242-9',
      'GB82-WEST-1234-5698-7654-32_',
      '+4242424242424242',
      // Four separators in a row are not a layout.
      '4242 -  4242 4242 4242',
    ]) {
      expect(restore([CARD, IBAN], text), text).toBe(text);
    }
  });

  it('never matches across lines', () => {
    expect(restore([CARD], '4242 4242\n4242 4242')).toBe(
      '4242 4242\n4242 4242',
    );
  });

  it('falls back to the real value as written when the layout does not fit', () => {
    // A stand-in with fewer characters than its real value (not produced
    // by the stand-in engine, but the matcher must stay correct).
    const odd = mapping('NATIONAL_ID', '123456789', '12-345-67890');
    expect(restore([odd], 'ID 123-456-789')).toBe('ID 12-345-67890');
  });
});

describe('card last four', () => {
  it.each([
    'your card ending in 4242',
    'the Visa ending with 4242',
    'card number **** **** **** 4242',
    'last four digits: 4242',
    'last 4 = 4242',
    'Mastercard 4242',
    'XXXX-4242',
  ])('restores %s', (text) => {
    expect(restore([CARD], text)).toBe(text.replace('4242', '1111'));
  });

  it('needs a card cue just before the digits, on the same line', () => {
    for (const text of [
      'order 4242 shipped',
      'card\n4242',
      `${'card'.padEnd(40, ' ')}4242`,
    ]) {
      expect(restore([CARD], text), text).toBe(text);
    }
    // Only the mention with a cue in its window.
    expect(
      restore([CARD], 'card ending in 4242. Your order reference is 4242'),
    ).toBe('card ending in 1111. Your order reference is 4242');
  });

  it('is not restored when two card stand-ins end in the same digits', () => {
    const other = mapping('CARD', '5555 5555 5555 4242', '5555 5555 5555 4444');
    expect(restore([CARD, other], 'card ending in 4242')).toBe(
      'card ending in 4242',
    );
    // Full numbers still restore.
    expect(restore([CARD, other], '5555-5555-5555-4242')).toBe(
      '5555-5555-5555-4444',
    );
  });

  it('ignores four digits inside a longer number or a date', () => {
    for (const text of [
      'card 1234 4242',
      'card 4242 5678',
      'card 12/4242',
      'card 4242/12',
      'card 42424',
    ]) {
      expect(restore([CARD], text), text).toBe(text);
    }
  });

  it('ignores last-four mentions of other types', () => {
    const iban = mapping(
      'BANK',
      'GB82 WEST 1234 5698 7654 4242',
      'GB29 NWBK 6016 1331 9268 19',
    );
    expect(restore([iban], 'card ending in 4242')).toBe('card ending in 4242');
  });
});

describe('phones in other forms', () => {
  const cases: [string, StandInMapping, [string, string][]][] = [
    [
      'GB',
      phone('+44 7400 123456', '+44 7700 900123'),
      [
        ['07400 123456', '07700 900123'],
        ['+44 7400 123456', '+44 7700 900123'],
        ['+447400123456', '+447700900123'],
        ['0044 7400 123456', '0044 7700 900123'],
        ['+44 (0)7400 123456', '+44 (0)7700 900123'],
        ['+44 (0) 7400 123 456', '+44 (0) 7700 900 123'],
        ['011 44 7400 123456', '011 44 7700 900123'],
        ['7400 123456', '7700 900123'],
        ['(07400) 123456', '(07700) 900123'],
      ],
    ],
    [
      'US',
      phone('+1 201 555 0123', '+1 212 555 0142'),
      [
        ['(201) 555-0123', '(212) 555-0142'],
        ['1-201-555-0123', '1-212-555-0142'],
        ['+1 201-555-0123', '+1 212-555-0142'],
        ['201.555.0123', '212.555.0142'],
        ['00 1 201 555 0123', '00 1 212 555 0142'],
      ],
    ],
    [
      // No trunk prefix: the leading 0 of a landline belongs to the number.
      'IT',
      phone('+39 312 345 6789', '+39 02 1234 5678'),
      [
        ['312 345 6789', '021 234 5678'],
        ['+39 312 345 6789', '+39 021 234 5678'],
        ['0039 3123456789', '0039 0212345678'],
      ],
    ],
    [
      'RU',
      phone('+7 301 123 45 67', '+7 912 345 67 89'),
      [
        ['8 (301) 123-45-67', '8 (912) 345-67-89'],
        ['+7 301 123-45-67', '+7 912 345-67-89'],
        ['810 7 301 123 45 67', '810 7 912 345 67 89'],
        ['8 301 1234567', '8 912 3456789'],
      ],
    ],
    [
      'HU',
      phone('+36 80 123 456', '+36 1 234 5678'),
      [
        ['06 80 123 456', '06 12 345 678'],
        ['+36 80 123 456', '+36 12 345 678'],
        ['06-80-123-456', '06-12-345-678'],
      ],
    ],
    [
      'IN',
      phone('+91 81234 56789', '+91 98765 43210'),
      [
        ['081234 56789', '098765 43210'],
        ['+91-81234-56789', '+91-98765-43210'],
        ['0091 8123456789', '0091 9876543210'],
      ],
    ],
    [
      'FR',
      phone('+33 1 23 45 67 89', '+33 6 12 34 56 78'),
      [
        ['01 23 45 67 89', '06 12 34 56 78'],
        ['+33 (0)1 23 45 67 89', '+33 (0)6 12 34 56 78'],
        ['0033 123456789', '0033 612345678'],
        ['01.23.45.67.89', '06.12.34.56.78'],
      ],
    ],
    [
      'DE',
      phone('+49 30 23125 456', '+49 30 23125 123'),
      [
        ['030 23125 456', '030 23125 123'],
        ['030/23125456', '030/23125123'],
        ['+49 (0)30 23125 456', '+49 (0)30 23125 123'],
        ['0049 30 23125456', '0049 30 23125123'],
      ],
    ],
  ];

  describe.each(cases)('%s', (_region, entry, forms) => {
    it.each(forms)('%s', (shown, real) => {
      expect(restore([entry], `Call ${shown} today.`)).toBe(
        `Call ${real} today.`,
      );
    });
  });

  it('keeps numbers with another calling code or trunk prefix', () => {
    const gb = phone('+44 7400 123456', '+44 7700 900123');
    const hu = phone('+36 80 123 456', '+36 1 234 5678');
    for (const text of [
      '+33 7400 123456',
      '0033 7400 123456',
      '17400 123456',
      '+1 7400 123456',
      '07400 1234567',
      '9 07400 123456',
    ]) {
      expect(restore([gb], text), text).toBe(text);
    }
    // Hungary dials 06, not 0, before the number.
    expect(restore([hu], '0 80 123 456')).toBe('0 80 123 456');
  });

  it('restores tel: forms', () => {
    const gb = phone('+44 7400 123456', '+44 7700 900123');
    expect(restore([gb], 'tel:+447400123456')).toBe('tel:+447700900123');
    expect(restore([gb], 'tel:07400-123456')).toBe('tel:07700-900123');
  });
});

describe('emails', () => {
  const DANA = mapping(
    'EMAIL',
    'standin.1.ab12@example.net',
    'dana.whitfield@example.com',
  );

  it.each([
    [
      "standin.1.ab12@example.net's inbox",
      "dana.whitfield@example.com's inbox",
    ],
    [
      'standin.1.ab12@example.net’s inbox',
      'dana.whitfield@example.com’s inbox',
    ],
    ['Standin.1.AB12@Example.net', 'dana.whitfield@example.com'],
    ['STANDIN.1.AB12@EXAMPLE.NET', 'DANA.WHITFIELD@EXAMPLE.COM'],
    ['<standin.1.ab12@example.net>', '<dana.whitfield@example.com>'],
    ['(standin.1.ab12@example.net).', '(dana.whitfield@example.com).'],
  ])('%s', (shown, real) => {
    expect(restore([DANA], shown)).toBe(real);
  });
});

describe('leak count', () => {
  const GB = phone('+44 7400 123456', '+44 7700 900123');
  const DANA = mapping(
    'EMAIL',
    'standin.1.ab12@example.net',
    'dana@example.com',
  );
  const all = [IBAN, NINO, CPF, CARD, GB, DANA];

  it('counts stand-ins in every form, fused ones too', () => {
    const matcher = createRestoreMatcher(all);
    const text = [
      'gb82west12345698765432',
      'QQ-12-34-56-A',
      '11144477735',
      '4242-4242-4242-4242',
      '+44 (0)7400 123456',
      'xstandin.1.ab12@example.net',
      'id9-4242-4242-4242-4242',
    ].join('\n');
    expect(matcher.countOccurrences(text)).toBe(7);
  });

  it('is zero once every form was restored', () => {
    const text =
      'gb82west12345698765432, QQ-12-34-56-A, 11144477735, 4242-4242-4242-4242, 0044 7400 123456, STANDIN.1.AB12@EXAMPLE.NET';
    const restored = restore(all, text);
    expect(restored).not.toBe(text);
    expect(createRestoreMatcher(all).countOccurrences(restored)).toBe(0);
  });
});

describe('phone prefix table', () => {
  const plan = new Metadata(metadata);

  it('matches the installed metadata for every calling code', () => {
    const idd = new Set<string>();
    for (const [code, regions] of Object.entries(
      metadata.country_calling_codes,
    )) {
      const prefixes = new Set<string>();
      for (const region of regions) {
        if (!(region in metadata.countries)) continue;
        plan.selectNumberingPlan(region);
        // The typings omit nationalPrefix(); compressed metadata holds 0
        // where a region has none.
        const numbering = plan.numberingPlan as
          { nationalPrefix(): unknown } | undefined;
        const national = numbering?.nationalPrefix();
        if (typeof national === 'string' && /^\d+$/u.test(national)) {
          prefixes.add(national);
        }
      }
      expect(prefixes.size, code).toBeLessThanOrEqual(1);
      expect(nationalPrefix(code), code).toBe([...prefixes][0] ?? null);
    }
    for (const region of Object.keys(metadata.countries)) {
      plan.selectNumberingPlan(
        region as Parameters<Metadata['selectNumberingPlan']>[0],
      );
      for (const prefix of [
        plan.numberingPlan?.defaultIDDPrefix(),
        plan.numberingPlan?.IDDPrefix(),
      ]) {
        if (prefix !== undefined && /^\d{2,}$/u.test(prefix)) idd.add(prefix);
      }
    }
    expect([...INTERNATIONAL_PREFIXES].sort()).toEqual([...idd].sort());
  });

  it.each([
    ['44', '0'],
    ['1', '1'],
    ['39', null],
    ['7', '8'],
    ['36', '06'],
    ['91', '0'],
    ['33', '0'],
    ['49', '0'],
  ])('calling code %s has national prefix %s', (code, prefix) => {
    expect(nationalPrefix(code)).toBe(prefix);
  });

  it('lists the common international prefixes', () => {
    for (const prefix of ['00', '011', '810', '0011']) {
      expect(INTERNATIONAL_PREFIXES).toContain(prefix);
    }
    expect(INTERNATIONAL_PREFIXES).not.toContain('0');
  });
});
