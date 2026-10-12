import { describe, expect, it } from 'vitest';
import { detectEmails } from '@/src/core/detect/rules/email.ts';

const values = (text: string): string[] =>
  detectEmails(text).map((span) => span.value);

describe('detectEmails', () => {
  describe('valid addresses', () => {
    it.each([
      [
        'simple',
        'Write to dana.whitfield@example.com today',
        'dana.whitfield@example.com',
      ],
      [
        'plus-addressing',
        'use dana+invoices@example.com',
        'dana+invoices@example.com',
      ],
      ['subdomain', 'ops@mail.eu.example.org', 'ops@mail.eu.example.org'],
      [
        'country-code second level',
        'h.pemberton@example.co.uk',
        'h.pemberton@example.co.uk',
      ],
      ['uppercase', 'CONTACT: JOHN.DOE@EXAMPLE.COM', 'JOHN.DOE@EXAMPLE.COM'],
      ['digits and underscore', 'user_42@example.net', 'user_42@example.net'],
      [
        'hyphenated domain',
        'a.b@my-company.example.com',
        'a.b@my-company.example.com',
      ],
      [
        'percent and hyphen in local part',
        'x%y-z@example.com',
        'x%y-z@example.com',
      ],
      ['apostrophe in local part', "o'brien@example.ie", "o'brien@example.ie"],
      [
        'Unicode local part',
        'jürgen.müller@example.de',
        'jürgen.müller@example.de',
      ],
      ['Unicode domain', 'info@bücher.example', 'info@bücher.example'],
      ['punycode TLD', 'admin@example.xn--p1ai', 'admin@example.xn--p1ai'],
      [
        'real TLD that is also an extension',
        'dev@example.app',
        'dev@example.app',
      ],
      ['at the very start', 'a@example.com is mine', 'a@example.com'],
      ['at the very end', 'mine is a@example.com', 'a@example.com'],
    ])('%s', (_label, text, expected) => {
      expect(values(text)).toEqual([expected]);
    });
  });

  describe('surrounding punctuation', () => {
    it.each([
      ['trailing full stop', 'Email dana@example.com.', 'dana@example.com'],
      ['trailing comma', 'dana@example.com, then', 'dana@example.com'],
      ['angle brackets', 'Dana <dana@example.com>', 'dana@example.com'],
      ['parentheses', '(dana@example.com)', 'dana@example.com'],
      ['square brackets', '[dana@example.com]', 'dana@example.com'],
      ['double quotes', '"dana@example.com"', 'dana@example.com'],
      ['single quotes', "'dana@example.com'", 'dana@example.com'],
      ['curly quotes', '“dana@example.com”', 'dana@example.com'],
      ['mailto link', 'mailto:dana@example.com?subject=Hi', 'dana@example.com'],
      ['question mark', 'Is it dana@example.com?', 'dana@example.com'],
      ['ellipsis before', 'and...dana@example.com', 'dana@example.com'],
      [
        'newline separated',
        'line one\ndana@example.com\nline three',
        'dana@example.com',
      ],
    ])('%s', (_label, text, expected) => {
      expect(values(text)).toEqual([expected]);
    });
  });

  describe('not email addresses', () => {
    it.each([
      ['no dot in domain', 'ssh user@localhost'],
      ['retina image name', 'image@2x.png'],
      ['retina svg', 'icon@3x.svg'],
      ['package version', 'react@18.3.1'],
      ['scoped package version', '@types/node@24.19.2'],
      ['mention', 'thanks @dana for this'],
      ['bare at sign', 'meet @ 5pm'],
      ['one-letter TLD', 'x@example.c'],
      ['numeric TLD', 'x@10.0.0.1'],
      ['local part ending in dot', 'dana.@example.com'],
      ['label starting with hyphen', 'dana@-example.com'],
      ['empty local part', '"@example.com"'],
      ['TLD followed by digits', 'dana@example.com1'],
      ['email-like dist tag', 'pkg@latest'],
    ])('%s', (_label, text) => {
      expect(detectEmails(text)).toEqual([]);
    });

    it('rejects a local part longer than 64 characters', () => {
      expect(detectEmails(`${'a'.repeat(65)}@example.com`)).toEqual([]);
      expect(values(`${'a'.repeat(64)}@example.com`)).toHaveLength(1);
    });

    it('rejects a label longer than 63 characters', () => {
      expect(detectEmails(`a@${'b'.repeat(64)}.com`)).toEqual([]);
    });
  });

  describe('spans', () => {
    it('reports start and end offsets that slice back to the value', () => {
      const text = 'From: dana@example.com, To: ops@example.org.';
      const spans = detectEmails(text);
      expect(spans).toEqual([
        { start: 6, end: 22, value: 'dana@example.com' },
        { start: 28, end: 43, value: 'ops@example.org' },
      ]);
      for (const span of spans) {
        expect(text.slice(span.start, span.end)).toBe(span.value);
      }
    });

    it('trims leading punctuation from the local part', () => {
      expect(detectEmails('--dana@example.com')).toEqual([
        { start: 2, end: 18, value: 'dana@example.com' },
      ]);
    });

    it('cuts the local part at a double dot', () => {
      expect(values('see..dana@example.com')).toEqual(['dana@example.com']);
    });

    it('cuts the domain at a double dot', () => {
      expect(values('dana@example.com..next')).toEqual(['dana@example.com']);
    });

    it('does not return overlapping spans', () => {
      expect(values('a@example.com@example.org')).toEqual(['a@example.com']);
    });

    it('finds many addresses in one text', () => {
      const text = Array.from(
        { length: 50 },
        (_, i) => `u${i.toString()}@example.com`,
      ).join(' ');
      expect(detectEmails(text)).toHaveLength(50);
    });

    it('returns nothing for text without an at sign', () => {
      expect(detectEmails('No addresses here.')).toEqual([]);
      expect(detectEmails('')).toEqual([]);
    });
  });

  describe('performance', () => {
    it.each([
      ['dotted run', `${'a.'.repeat(100_000)}@`],
      ['many at signs', '@'.repeat(200_000)],
      ['alternating', 'a@'.repeat(100_000)],
      ['long domain run', `a@${'b-'.repeat(100_000)}`],
    ])('stays fast on adversarial input: %s', (_label, text) => {
      const startedAt = performance.now();
      detectEmails(text);
      expect(performance.now() - startedAt).toBeLessThan(1000);
    });
  });
});
