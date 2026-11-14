import metadata from 'libphonenumber-js/metadata.max.json';
import { describe, expect, it } from 'vitest';
import { normaliseReal } from '@/src/core/detect/normal-form.ts';
import { CALLING_CODES } from '@/src/core/net/calling-codes.ts';
import { compactForm, MIN_FORM_LENGTH } from '@/src/core/net/compact.ts';
import { netForms } from '@/src/core/net/forms.ts';
import { createRollingHash, rollingBase } from '@/src/core/net/rolling.ts';

describe('compactForm', () => {
  it('keeps letters and digits, lower case, after NFKC', () => {
    expect(compactForm('AB 12-34.56/C')).toBe('ab123456c');
    expect(compactForm('ＡＢ１２３')).toBe('ab123');
    expect(compactForm('+44 (0)7400 123456')).toBe('4407400123456');
    // Letters of other scripts count; punctuation of any script does not.
    expect(compactForm('Ünïcode·名前、x')).toBe('ünïcode名前x');
    expect(compactForm('a\u{1D400}b')).toBe('aab');
  });
});

describe('netForms', () => {
  const forms = (
    type: Parameters<typeof netForms>[0],
    value: string,
    country: Parameters<typeof normaliseReal>[2] = null,
  ) => netForms(type, value, normaliseReal(type, null, country, value));

  it('uses the national significant number of a phone', () => {
    // libphonenumber's example numbers.
    expect(forms('PHONE', '07400 123456', 'GB')).toEqual(['7400123456']);
    expect(forms('PHONE', '+44 7400 123456')).toEqual(['7400123456']);
    expect(forms('PHONE', '(506) 234-5678', 'CA')).toEqual(['5062345678']);
    expect(forms('PHONE', '+33 6 12 34 56 78')).toEqual(['612345678']);
  });

  it('uses the digits of a phone the library could not parse', () => {
    // A national number that is not valid for its region keeps its digits.
    expect(forms('PHONE', '07700 900123', 'GB')).toEqual(['07700900123']);
  });

  it('uses the compact form of every other type', () => {
    expect(forms('EMAIL', 'Dana.Whitfield@Example.com')).toEqual([
      'danawhitfieldexamplecom',
    ]);
    expect(forms('CARD', '4111 1111 1111 1111')).toEqual(['4111111111111111']);
  });

  it(`leaves out forms shorter than ${MIN_FORM_LENGTH.toString()}`, () => {
    expect(forms('SECRET', 'pw-12')).toEqual([]);
  });
});

describe('calling codes', () => {
  it('match the installed phone metadata and are prefix-free', () => {
    expect([...CALLING_CODES].sort()).toEqual(
      Object.keys(metadata.country_calling_codes).sort(),
    );
    for (const a of CALLING_CODES) {
      for (const b of CALLING_CODES) {
        if (a !== b) expect(b.startsWith(a), `${a} / ${b}`).toBe(false);
      }
    }
  });
});

describe('rolling hash', () => {
  const rolling = createRollingHash(rollingBase('d4'.repeat(32)));

  it('finds every window whose value matches, and only those', () => {
    const text = 'xx7400123456yy7400123456';
    const target = new Set([rolling.of('7400123456')]);
    const starts: number[] = [];
    rolling.scan(text, 10, target, (start) => {
      starts.push(start);
      return false;
    });
    expect(starts).toEqual([2, 14]);
    expect(
      rolling.scan(text, 10, new Set([rolling.of('0000000000')]), () => true),
    ).toBe(false);
  });

  it('stops at the first confirmed window', () => {
    let calls = 0;
    const found = rolling.scan('aaaa', 2, new Set([rolling.of('aa')]), () => {
      calls += 1;
      return true;
    });
    expect(found).toBe(true);
    expect(calls).toBe(1);
  });

  it('handles texts shorter than the window and non-ASCII characters', () => {
    expect(rolling.scan('abc', 5, new Set([0]), () => true)).toBe(false);
    const text = 'zz名前123456';
    expect(
      rolling.scan(text, 8, new Set([rolling.of('名前123456')]), () => true),
    ).toBe(true);
  });

  it('depends on the key', () => {
    const other = createRollingHash(rollingBase('e5'.repeat(32)));
    expect(rolling.of('7400123456')).not.toBe(other.of('7400123456'));
  });
});
