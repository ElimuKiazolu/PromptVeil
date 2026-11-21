import { describe, expect, it } from 'vitest';
import { unescapeText } from '@/src/core/net/unescape.ts';

const plain = (text: string): string => unescapeText(text).text;

/** The original text of an output span, through the offset map. */
function source(text: string, start: number, end: number): string {
  const { sources } = unescapeText(text);
  return text.slice(sources[start], sources[end]);
}

describe('unescapeText', () => {
  it('leaves plain ASCII text unchanged, with an identity map', () => {
    const result = unescapeText('Mail dana@example.com today.');
    expect(result.text).toBe('Mail dana@example.com today.');
    expect(result.sources).toEqual(
      Array.from({ length: result.text.length + 1 }, (_v, i) => i),
    );
  });

  it('undoes markdown backslash escapes before punctuation', () => {
    expect(plain(String.raw`sam\_lee\@example.com`)).toBe(
      'sam_lee@example.com',
    );
    expect(plain(String.raw`\*bold\* \# not a heading \\ \[x\]`)).toBe(
      String.raw`*bold* # not a heading \ [x]`,
    );
  });

  it('keeps a backslash that escapes nothing', () => {
    expect(plain(String.raw`C:\Users\dana`)).toBe(String.raw`C:\Users\dana`);
    expect(plain('end\\')).toBe('end\\');
  });

  it('decodes numeric references, decimal and hex, with or without ;', () => {
    expect(plain('07400&#x20;123456')).toBe('07400 123456');
    expect(plain('07400&#32;123456')).toBe('07400 123456');
    expect(plain('dana&#64;example.com')).toBe('dana@example.com');
    expect(plain('dana&#X40;example.com')).toBe('dana@example.com');
    // Without the semicolon the digits run as far as they can.
    expect(plain('dana&#64example.com')).toBe('dana@example.com');
    expect(plain('&#x40e')).toBe('Ў');
    expect(plain('&#x1F600;')).toBe('\u{1F600}');
  });

  it('decodes named references, and the legacy ones without ;', () => {
    expect(plain('AB&nbsp;12&nbsp;34&nbsp;56&nbsp;C')).toBe('AB 12 34 56 C');
    expect(plain('dana&commat;example&period;com')).toBe('dana@example.com');
    expect(plain('a &amp; b, a &amp b')).toBe('a & b, a & b');
    expect(plain('&lt;tag&gt; &quot;x&quot; &apos;y&apos;')).toBe(
      '<tag> "x" \'y\'',
    );
  });

  it('leaves unknown, invalid and incomplete references as written', () => {
    expect(plain('&unknown; &#; &#x; &#0; &#xD800; &#x110000; & x')).toBe(
      '&unknown; &#; &#x; &#0; &#xD800; &#x110000; & x',
    );
    // "commat" is only decoded with its semicolon.
    expect(plain('&commat')).toBe('&commat');
  });

  it('decodes one level only', () => {
    expect(plain('&amp;#x20;')).toBe('&#x20;');
    expect(plain(String.raw`\&#x20;`)).toBe('&#x20;');
  });

  it('turns Unicode spaces into spaces', () => {
    expect(plain('07400\u00a0123456')).toBe('07400 123456');
    expect(plain('AB\u202f12\u200912\u300012')).toBe('AB 12 12 12');
    expect(plain('&#x202F;')).toBe(' ');
  });

  it('removes zero-width characters and soft hyphens', () => {
    expect(plain('da\u200bna@exam\u00adple.com')).toBe('dana@example.com');
    expect(plain('da&zwj;na&#x200B;@example.com')).toBe('dana@example.com');
  });

  it('normalises full-width forms (NFKC)', () => {
    expect(plain('０７４００ １２３４５６')).toBe('07400 123456');
    expect(plain('ＡＢ１２３４５６Ｃ')).toBe('AB123456C');
  });

  it('maps every output span back to its source', () => {
    const text = String.raw`mail sam\_lee\@example.com or 07400&#x20;123456`;
    const result = unescapeText(text);
    const email = result.text.indexOf('sam_lee@example.com');
    expect(source(text, email, email + 'sam_lee@example.com'.length)).toBe(
      String.raw`sam\_lee\@example.com`,
    );
    const phone = result.text.indexOf('07400 123456');
    expect(source(text, phone, phone + '07400 123456'.length)).toBe(
      '07400&#x20;123456',
    );
    expect(result.sources).toHaveLength(result.text.length + 1);
    expect(result.sources.at(-1)).toBe(text.length);
  });

  it('maps removed and expanded characters consistently', () => {
    const text = 'a\u200bb\ufb01c';
    const result = unescapeText(text);
    expect(result.text).toBe('abfic');
    // Both letters of the ligature come from its one source character.
    expect(result.sources).toEqual([0, 2, 3, 3, 4, 5]);
  });

  it('is linear on long and hostile input', () => {
    const hostile =
      '&'.repeat(50_000) + '\\'.repeat(50_000) + '&#'.repeat(25_000);
    const started = performance.now();
    unescapeText(hostile);
    expect(performance.now() - started).toBeLessThan(500);
  });
});
