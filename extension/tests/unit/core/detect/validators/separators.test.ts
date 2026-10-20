import { describe, expect, it } from 'vitest';
import {
  removeNumericSeparators,
  stripGroupSeparators,
} from '@/src/core/detect/validators/separators.ts';

describe('stripGroupSeparators', () => {
  it('removes one consistent separator kind', () => {
    expect(stripGroupSeparators('1234 5678', [' ', '-'])).toBe('12345678');
    expect(stripGroupSeparators('1234-5678', [' ', '-'])).toBe('12345678');
    expect(stripGroupSeparators('12345678', [' ', '-'])).toBe('12345678');
  });

  it('rejects mixed, doubled and edge separators', () => {
    expect(stripGroupSeparators('12 34-56', [' ', '-'])).toBeNull();
    expect(stripGroupSeparators('12  34', [' ', '-'])).toBeNull();
    expect(stripGroupSeparators(' 1234', [' ', '-'])).toBeNull();
    expect(stripGroupSeparators('1234-', [' ', '-'])).toBeNull();
    expect(stripGroupSeparators('-', [' ', '-'])).toBeNull();
  });

  it('leaves characters that are not allowed separators in place', () => {
    expect(stripGroupSeparators('12-34', [' '])).toBe('12-34');
    expect(stripGroupSeparators('', [' '])).toBe('');
  });
});

describe('removeNumericSeparators', () => {
  it('removes spaces, hyphens, dots and slashes', () => {
    expect(removeNumericSeparators(' 111.444.777-35 ')).toBe('11144477735');
    expect(removeNumericSeparators('12/34 56')).toBe('123456');
  });
});
