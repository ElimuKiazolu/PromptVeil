import { describe, expect, it } from 'vitest';
import { prepareText } from '@/src/core/detect/text.ts';

/** The original text covered by a span of the match text. */
function originalOf(original: string, start: number, end: number): string {
  const text = prepareText(original);
  const span = text.toOriginal(start, end);
  return original.slice(span.start, span.end);
}

describe('prepareText', () => {
  it('leaves ASCII text as it is, with identity offsets', () => {
    const text = prepareText('call +44 20 7946 0018 now');
    expect(text.text).toBe('call +44 20 7946 0018 now');
    expect(text.toOriginal(5, 21)).toEqual({ start: 5, end: 21 });
  });

  it('folds full-width digits, letters and symbols', () => {
    const original =
      'card ４２４２ ４２４２ and ｄａｎａ＠ｅｘａｍｐｌｅ．ｃｏｍ';
    const text = prepareText(original);
    expect(text.text).toBe('card 4242 4242 and dana@example.com');
    const at = text.text.indexOf('dana');
    expect(originalOf(original, at, at + 'dana@example.com'.length)).toBe(
      'ｄａｎａ＠ｅｘａｍｐｌｅ．ｃｏｍ',
    );
  });

  it('turns every Unicode space into a plain space', () => {
    // No-break, thin, narrow no-break, figure and ideographic spaces.
    const original = 'GB29\u00A0NWBK\u20096016\u202F1331\u20079268\u300019';
    const text = prepareText(original);
    expect(text.text).toBe('GB29 NWBK 6016 1331 9268 19');
    expect(originalOf(original, 0, text.text.length)).toBe(original);
  });

  it('removes zero-width characters and soft hyphens inside numbers and words', () => {
    const original = '4242\u200B4242\u200C4242\u200D4242 and in\u00ADvoice';
    const text = prepareText(original);
    expect(text.text).toBe('4242424242424242 and invoice');
    expect(originalOf(original, 0, 16)).toBe(
      '4242\u200B4242\u200C4242\u200D4242',
    );
  });

  it('keeps zero-width characters between words as boundaries', () => {
    const text = prepareText('word\u200B more and \u2060lead');
    // Between a letter and a space, or after a space: kept.
    expect(text.text).toBe('word\u200B more and \u2060lead');
    expect(prepareText('a\u200Bb').text).toBe('ab');
    expect(prepareText('a \u200Bb').text).toBe('a \u200Bb');
  });

  it('maps a span inside an expansion to the whole source character', () => {
    // U+FB01 (ﬁ ligature) folds to two letters.
    const original = 'xﬁy';
    const text = prepareText(original);
    expect(text.text).toBe('xfiy');
    expect(text.toOriginal(1, 2)).toEqual({ start: 1, end: 2 });
    expect(text.toOriginal(2, 4)).toEqual({ start: 1, end: 3 });
  });

  it('keeps characters outside the BMP whole', () => {
    const original = 'a😀 4242';
    const text = prepareText(original);
    expect(text.text).toBe(original);
    const at = text.text.indexOf('4242');
    expect(originalOf(original, at, at + 4)).toBe('4242');
  });

  it('maps an empty span to a point', () => {
    const text = prepareText('ａｂ');
    expect(text.toOriginal(1, 1)).toEqual({ start: 1, end: 1 });
  });

  it('handles text pasted from a PDF or Word (mixed spaces and joiners)', () => {
    const original =
      'IBAN:\u00A0DE89\u00A03704\u200B0044\u00A00532\u00A00130\u00A000\r\nTel.\u202F+49\u00A030\u00A0123456';
    const text = prepareText(original);
    expect(text.text).toBe(
      'IBAN: DE89 37040044 0532 0130 00\r\nTel. +49 30 123456',
    );
    const at = text.text.indexOf('DE89');
    expect(
      originalOf(original, at, at + 'DE89 37040044 0532 0130 00'.length),
    ).toBe('DE89\u00A03704\u200B0044\u00A00532\u00A00130\u00A000');
  });
});
