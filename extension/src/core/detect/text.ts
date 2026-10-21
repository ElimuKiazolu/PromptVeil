/**
 * Text prepared for matching, with a map back to the original.
 *
 * Text pasted from PDFs, Word or web pages often carries characters that look
 * normal but break patterns: full-width digits and letters, no-break and thin
 * spaces, zero-width characters and soft hyphens inside numbers. Rules match
 * against a normalised copy:
 * - each code point outside ASCII is replaced by its NFKC form
 *   (full-width "４２" → "42", "＠" → "@");
 * - every Unicode space separator becomes " ";
 * - zero-width characters and soft hyphens are removed when they sit between
 *   two letters or digits, and left in place (as a boundary) elsewhere, so
 *   two words are never joined into one.
 *
 * Normalisation is per code point, so every character of the copy comes from
 * exactly one original character and spans map back exactly: a detection
 * always covers whole original characters and its value is the original text.
 */

export interface Span {
  start: number;
  end: number;
}

export interface MatchText {
  /** The prompt as written. */
  readonly original: string;
  /** The normalised copy that rules match against. */
  readonly text: string;
  /** The original span covering `text.slice(start, end)`. */
  toOriginal(start: number, end: number): Span;
}

/** Removed between letters or digits: ZWSP, ZWNJ, ZWJ, word joiner, BOM, soft hyphen. */
const INVISIBLE = new Set([
  '\u200B',
  '\u200C',
  '\u200D',
  '\u2060',
  '\uFEFF',
  '\u00AD',
]);
const SPACE_SEPARATOR = /^\p{Zs}$/u;
const LETTER_OR_DIGIT = /^[\p{L}\p{Nd}]$/u;
const NON_ASCII = /\P{ASCII}/u;

/** NFKC form of one non-ASCII code point, used for matching. */
function foldCodePoint(char: string): string {
  if (SPACE_SEPARATOR.test(char)) return ' ';
  const folded = char.normalize('NFKC');
  // A character that folds to nothing keeps its place as a boundary.
  return folded.length === 0 ? char : folded;
}

function isAsciiLetterOrDigit(code: number): boolean {
  return (
    (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122)
  );
}

function isLetterOrDigit(char: string): boolean {
  if (char === '') return false;
  const code = char.charCodeAt(0);
  return code < 128 ? isAsciiLetterOrDigit(code) : LETTER_OR_DIGIT.test(char);
}

export function prepareText(original: string): MatchText {
  if (!NON_ASCII.test(original)) {
    return {
      original,
      text: original,
      toOriginal: (start, end) => ({ start, end }),
    };
  }

  // Folded forms of the non-ASCII characters seen in this text.
  const folds = new Map<string, string>();
  const fold = (char: string): string => {
    if (char.charCodeAt(0) < 128) return char;
    let folded = folds.get(char);
    if (folded === undefined) {
      folded = foldCodePoint(char);
      folds.set(char, folded);
    }
    return folded;
  };
  const codePointAt = (at: number): string =>
    String.fromCodePoint(original.codePointAt(at) ?? 0);

  /** First folded character from `from` on, skipping invisible ones. */
  const nextVisible = (from: number): string => {
    for (let k = from; k < original.length;) {
      const char = codePointAt(k);
      if (!INVISIBLE.has(char)) return fold(char).charAt(0);
      k += char.length;
    }
    return '';
  };

  const parts: string[] = [];
  // Original span of each UTF-16 unit of the match text.
  const starts: number[] = [];
  const ends: number[] = [];
  let last = '';
  for (let at = 0; at < original.length;) {
    if (original.charCodeAt(at) < 128) {
      const char = original.charAt(at);
      parts.push(char);
      starts.push(at);
      ends.push(at + 1);
      last = char;
      at += 1;
      continue;
    }
    const char = codePointAt(at);
    const end = at + char.length;
    if (
      INVISIBLE.has(char) &&
      isLetterOrDigit(last) &&
      isLetterOrDigit(nextVisible(end))
    ) {
      at = end;
      continue;
    }
    const replacement = fold(char);
    parts.push(replacement);
    for (let unit = replacement.length; unit > 0; unit -= 1) {
      starts.push(at);
      ends.push(end);
    }
    last = replacement.charAt(replacement.length - 1);
    at = end;
  }
  const text = parts.join('');

  return {
    original,
    text,
    toOriginal: (start, end) => {
      if (end <= start) {
        const at = starts[start] ?? original.length;
        return { start: at, end: at };
      }
      return {
        start: starts[start] ?? original.length,
        end: ends[end - 1] ?? original.length,
      };
    },
  };
}
