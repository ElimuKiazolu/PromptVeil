import { describe, expect, it } from 'vitest';
import { createRestoreMatcher } from '@/src/core/restore/matcher.ts';
import type { StandInMapping } from '@/src/core/restore/types.ts';

const email = (standIn: string, real: string): StandInMapping => ({
  standIn,
  real,
  boundary: 'email',
});

const word = (standIn: string, real: string): StandInMapping => ({
  standIn,
  real,
  boundary: 'word',
});

const DANA = email('standin.1@example.net', 'dana@example.com');
const OPS = email('standin.2@example.net', 'ops@example.org');

const reals = (mappings: StandInMapping[], text: string): string[] =>
  createRestoreMatcher(mappings)
    .find(text)
    .map((r) => r.real);

/** Applies replacements the way a caller would, for readable assertions. */
function restore(mappings: StandInMapping[], text: string): string {
  let out = '';
  let cursor = 0;
  for (const r of createRestoreMatcher(mappings).find(text)) {
    out += text.slice(cursor, r.start) + r.real;
    cursor = r.end;
  }
  return out + text.slice(cursor);
}

describe('createRestoreMatcher', () => {
  describe('emails', () => {
    it.each([
      [
        'plain sentence',
        'Contact standin.1@example.net today.',
        'Contact dana@example.com today.',
      ],
      [
        'sentence-final full stop',
        'Write to standin.1@example.net.',
        'Write to dana@example.com.',
      ],
      [
        'trailing comma',
        'standin.1@example.net, please',
        'dana@example.com, please',
      ],
      ['angle brackets', '<standin.1@example.net>', '<dana@example.com>'],
      ['parentheses', '(standin.1@example.net)', '(dana@example.com)'],
      ['double quotes', '"standin.1@example.net"', '"dana@example.com"'],
      ['single quotes', "'standin.1@example.net'", "'dana@example.com'"],
      [
        'mailto prefix',
        'mailto:standin.1@example.net',
        'mailto:dana@example.com',
      ],
      [
        'mailto with query',
        'mailto:standin.1@example.net?subject=Hi',
        'mailto:dana@example.com?subject=Hi',
      ],
      [
        'start of text',
        'standin.1@example.net wrote',
        'dana@example.com wrote',
      ],
      ['end of text', 'from standin.1@example.net', 'from dana@example.com'],
      [
        'newline neighbours',
        'a\nstandin.1@example.net\nb',
        'a\ndana@example.com\nb',
      ],
      ['uppercase', 'STANDIN.1@EXAMPLE.NET', 'dana@example.com'],
      ['mixed case', 'Standin.1@Example.Net', 'dana@example.com'],
      ['colon after', 'standin.1@example.net: hi', 'dana@example.com: hi'],
      [
        'question mark after',
        'Is it standin.1@example.net?',
        'Is it dana@example.com?',
      ],
    ])('%s', (_label, text, expected) => {
      expect(restore([DANA], text)).toBe(expected);
    });

    it.each([
      ['letter before', 'xstandin.1@example.net'],
      ['digit before', '9standin.1@example.net'],
      ['dot before', 'a.standin.1@example.net'],
      ['plus before', 'a+standin.1@example.net'],
      ['longer domain', 'standin.1@example.net.au'],
      ['longer TLD', 'standin.1@example.network'],
      ['hyphen after', 'standin.1@example.net-x'],
      ['digit after', 'standin.1@example.net2'],
      ['glued on both sides', 'xstandin.1@example.net.au'],
      ['partial stand-in', 'standin.1@example.ne'],
      ['different number', 'standin.12@example.net'],
    ])('does not match: %s', (_label, text) => {
      expect(createRestoreMatcher([DANA]).find(text)).toEqual([]);
    });

    it('restores several stand-ins in one text', () => {
      expect(
        restore([DANA, OPS], 'standin.2@example.net and standin.1@example.net'),
      ).toBe('ops@example.org and dana@example.com');
    });

    it('restores repeated stand-ins', () => {
      expect(
        reals([DANA], 'standin.1@example.net standin.1@example.net'),
      ).toEqual(['dana@example.com', 'dana@example.com']);
    });

    it('keeps stand-ins that share a prefix apart', () => {
      const twelve = email('standin.12@example.net', 'twelve@example.com');
      expect(
        restore(
          [DANA, twelve],
          'standin.12@example.net vs standin.1@example.net',
        ),
      ).toBe('twelve@example.com vs dana@example.com');
    });

    it('reports offsets and the text as it appeared', () => {
      expect(
        createRestoreMatcher([DANA]).find('Hi STANDIN.1@example.net!'),
      ).toEqual([
        {
          start: 3,
          end: 24,
          standIn: 'STANDIN.1@example.net',
          real: 'dana@example.com',
        },
      ]);
    });

    it('continues scanning after a rejected candidate', () => {
      expect(
        reals([DANA], 'xstandin.1@example.net then standin.1@example.net'),
      ).toEqual(['dana@example.com']);
    });
  });

  describe('words', () => {
    const ANNA = word('Mira', 'Anna');
    const MIRANDA = word('Miranda', 'Joanna');

    it('restores whole words only', () => {
      expect(restore([ANNA], 'Mira, meet Miracle and mira.')).toBe(
        'Anna, meet Miracle and Anna.',
      );
    });

    it('prefers the longest stand-in at a position', () => {
      expect(restore([ANNA, MIRANDA], 'Miranda and Mira')).toBe(
        'Joanna and Anna',
      );
    });

    it('falls back to a shorter stand-in when the longer is not delimited', () => {
      const mira = word('Mira', 'Anna');
      const miraX = word('Mira-X', 'Other');
      // "Mira-Xy" is not a whole "Mira-X", but "Mira" alone is followed by "-".
      expect(restore([mira, miraX], 'Mira-Xy')).toBe('Anna-Xy');
    });

    it('handles Unicode stand-ins', () => {
      expect(restore([word('José', 'Lena')], 'Hola José.')).toBe('Hola Lena.');
    });
  });

  describe('special cases', () => {
    it('returns nothing without mappings', () => {
      const matcher = createRestoreMatcher([]);
      expect(matcher.find('standin.1@example.net')).toEqual([]);
      expect(matcher.countOccurrences('standin.1@example.net')).toBe(0);
    });

    it('ignores empty stand-ins', () => {
      expect(createRestoreMatcher([email('', 'x')]).find('anything')).toEqual(
        [],
      );
    });

    it('treats regular-expression characters literally', () => {
      const odd = word('a.b*c', 'real');
      expect(restore([odd], 'x a.b*c y aXbbc')).toBe('x real y aXbbc');
    });

    it('scales to many mappings', () => {
      const many = Array.from({ length: 500 }, (_, i) =>
        email(
          `standin.${(i + 1).toString()}@example.net`,
          `r${i.toString()}@example.com`,
        ),
      );
      const text = `${'filler '.repeat(5000)}standin.250@example.net`;
      const startedAt = performance.now();
      expect(reals(many, text)).toEqual(['r249@example.com']);
      expect(performance.now() - startedAt).toBeLessThan(1000);
    });
  });

  describe('countOccurrences', () => {
    it('counts delimited and fused stand-ins', () => {
      const matcher = createRestoreMatcher([DANA, OPS]);
      expect(
        matcher.countOccurrences(
          'standin.1@example.net, xstandin.2@example.net.au and dana@example.com',
        ),
      ).toBe(2);
    });

    it('is zero for restored text', () => {
      expect(
        createRestoreMatcher([DANA]).countOccurrences('dana@example.com'),
      ).toBe(0);
    });
  });
});
