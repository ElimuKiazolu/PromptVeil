/**
 * Undoes the escaping a site applies to text it saves, so the detector and
 * the request safety net read text as the user typed it. ChatGPT's editors,
 * for example, save markdown with backslash escapes (`sam\_lee\@…`) and
 * write some spaces as HTML entities (`&#x20;`).
 *
 * One pass, never recursive (an escaped entity stays one level escaped):
 * - markdown backslash escapes: a backslash before ASCII punctuation;
 * - HTML character references: numeric (decimal and hex) and the named ones
 *   below, with the semicolon (and the legacy few browsers accept without);
 * - then, per character: Unicode spaces become " ", zero-width characters
 *   and soft hyphens are removed, other non-ASCII characters are NFKC
 *   normalised (full-width digits and letters become ASCII).
 *
 * `sources[i]` is the index in the original text of the escape or character
 * that produced output unit i; `sources[text.length]` is the original
 * length, so a span [start, end) maps back to [sources[start],
 * sources[end]).
 */

export interface Unescaped {
  readonly text: string;
  readonly sources: readonly number[];
}

/**
 * Named references that can stand for characters in personal data or its
 * separators. Unknown names are left as written.
 */
const NAMED: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: '\u00a0',
  NonBreakingSpace: '\u00a0',
  ensp: '\u2002',
  emsp: '\u2003',
  emsp13: '\u2004',
  emsp14: '\u2005',
  numsp: '\u2007',
  puncsp: '\u2008',
  thinsp: '\u2009',
  ThinSpace: '\u2009',
  hairsp: '\u200a',
  VeryThinSpace: '\u200a',
  MediumSpace: '\u205f',
  ZeroWidthSpace: '\u200b',
  NegativeThinSpace: '\u200b',
  zwnj: '\u200c',
  zwj: '\u200d',
  NoBreak: '\u2060',
  shy: '\u00ad',
  Tab: '\t',
  NewLine: '\n',
  commat: '@',
  period: '.',
  comma: ',',
  colon: ':',
  semi: ';',
  excl: '!',
  quest: '?',
  num: '#',
  dollar: '$',
  percnt: '%',
  ast: '*',
  midast: '*',
  plus: '+',
  equals: '=',
  hyphen: '\u2010',
  dash: '\u2010',
  minus: '\u2212',
  ndash: '\u2013',
  mdash: '\u2014',
  lowbar: '_',
  UnderBar: '_',
  sol: '/',
  bsol: '\\',
  verbar: '|',
  vert: '|',
  lpar: '(',
  rpar: ')',
  lsqb: '[',
  lbrack: '[',
  rsqb: ']',
  rbrack: ']',
  lcub: '{',
  lbrace: '{',
  rcub: '}',
  rbrace: '}',
  grave: '`',
  Hat: '^',
  tilde: '\u02dc',
  middot: '\u00b7',
  centerdot: '\u00b7',
  bull: '\u2022',
  hellip: '\u2026',
  lsquo: '\u2018',
  rsquo: '\u2019',
  sbquo: '\u201a',
  ldquo: '\u201c',
  rdquo: '\u201d',
  bdquo: '\u201e',
  laquo: '\u00ab',
  raquo: '\u00bb',
  copy: '\u00a9',
  reg: '\u00ae',
  trade: '\u2122',
  deg: '\u00b0',
  euro: '\u20ac',
  pound: '\u00a3',
  yen: '\u00a5',
  cent: '\u00a2',
};

/** Named references browsers also decode without the semicolon. */
const LEGACY = new Set(['amp', 'lt', 'gt', 'quot', 'nbsp', 'copy', 'reg']);

/** Longest name in NAMED (bounds the scan after "&"). */
const MAX_NAME = 20;

const MAX_CODE_POINT = 0x10ffff;

function isAsciiPunctuation(code: number): boolean {
  return (
    (code >= 33 && code <= 47) ||
    (code >= 58 && code <= 64) ||
    (code >= 91 && code <= 96) ||
    (code >= 123 && code <= 126)
  );
}

function isAsciiLetterOrDigit(code: number): boolean {
  return (
    (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122)
  );
}

function isHexDigit(code: number): boolean {
  return (
    (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 70) ||
    (code >= 97 && code <= 102)
  );
}

/** Spaces other than " " that separate words or digit groups. */
const UNICODE_SPACE = /^[\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000]$/u;
/** Invisible characters that only hide what is around them. */
const INVISIBLE = /^[\u00ad\u180e\u200b-\u200d\u2060\ufeff]$/u;

interface Reference {
  /** The decoded character(s). */
  value: string;
  /** Length of the reference in the source. */
  length: number;
}

/** A numeric character reference at `start` ("&#…"), or null. */
function numericReference(text: string, start: number): Reference | null {
  let i = start + 2;
  const hex = text.charCodeAt(i) === 120 || text.charCodeAt(i) === 88;
  if (hex) i += 1;
  const digitsStart = i;
  let value = 0;
  while (i < text.length && i - digitsStart < 8) {
    const code = text.charCodeAt(i);
    if (hex ? !isHexDigit(code) : code < 48 || code > 57) break;
    value = value * (hex ? 16 : 10) + Number.parseInt(text.charAt(i), 16);
    i += 1;
  }
  if (i === digitsStart) return null;
  if (text.charCodeAt(i) === 59) i += 1;
  // Out of range and surrogate halves are not characters: left as written.
  if (value === 0 || value > MAX_CODE_POINT) return null;
  if (value >= 0xd800 && value <= 0xdfff) return null;
  return { value: String.fromCodePoint(value), length: i - start };
}

/** A named character reference at `start` ("&name;"), or null. */
function namedReference(text: string, start: number): Reference | null {
  let i = start + 1;
  while (
    i < text.length &&
    i - start <= MAX_NAME &&
    isAsciiLetterOrDigit(text.charCodeAt(i))
  ) {
    i += 1;
  }
  const name = text.slice(start + 1, i);
  if (name === '') return null;
  const value = NAMED[name];
  if (value === undefined) return null;
  if (text.charCodeAt(i) === 59) return { value, length: i + 1 - start };
  return LEGACY.has(name) ? { value, length: i - start } : null;
}

/** True when the text has nothing this module would change. */
function isPlain(text: string): boolean {
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code === 38 || code === 92 || code >= 128) return false;
  }
  return true;
}

export function unescapeText(text: string): Unescaped {
  if (isPlain(text)) {
    const sources = Array.from({ length: text.length + 1 }, (_v, i) => i);
    return { text, sources };
  }
  let out = '';
  const sources: number[] = [];

  /** Appends one decoded character, normalised, produced at `source`. */
  const emit = (char: string, source: number): void => {
    if (char.length === 1 && char.charCodeAt(0) < 128) {
      out += char;
      sources.push(source);
      return;
    }
    if (UNICODE_SPACE.test(char)) {
      out += ' ';
      sources.push(source);
      return;
    }
    if (INVISIBLE.test(char)) return;
    const normalised = char.normalize('NFKC');
    // One source index per UTF-16 unit of the normalised form.
    for (let left = normalised.length; left > 0; left -= 1) {
      sources.push(source);
    }
    out += normalised;
  };

  let i = 0;
  while (i < text.length) {
    const code = text.charCodeAt(i);
    if (code === 92 && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1);
      if (isAsciiPunctuation(next)) {
        emit(text.charAt(i + 1), i);
        i += 2;
        continue;
      }
    }
    if (code === 38) {
      const reference =
        text.charCodeAt(i + 1) === 35
          ? numericReference(text, i)
          : namedReference(text, i);
      if (reference !== null) {
        for (const char of reference.value) emit(char, i);
        i += reference.length;
        continue;
      }
    }
    // Whole code points, so a surrogate pair is normalised as one character.
    const point = text.codePointAt(i) ?? code;
    const char = String.fromCodePoint(point);
    emit(char, i);
    i += char.length;
  }
  sources.push(text.length);
  return { text: out, sources };
}
