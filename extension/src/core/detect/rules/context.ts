import type { Span } from '../text.ts';
import type { ContextWords } from './types.ts';

const ASCII_WORD_CHAR = /^[a-z0-9]$/;

/**
 * The text in a window, lower-cased, with underscores, hyphens, runs of
 * whitespace and camelCase boundaries turned into single spaces, so "api_key",
 * "x-api-key", "apiKey" and "API key" all read "api key".
 */
function windowText(text: string, from: number, to: number): string {
  return text
    .slice(Math.max(0, from), Math.max(0, to))
    .replace(/([a-z0-9])([A-Z])/gu, '$1 $2')
    .toLowerCase()
    .replace(/[\s_-]+/gu, ' ');
}

function isBoundary(char: string): boolean {
  return char === '' || !ASCII_WORD_CHAR.test(char);
}

/** True when `word` occurs in `haystack` as a whole word (Latin) or anywhere (other scripts). */
export function containsWord(haystack: string, word: string): boolean {
  const first = word.charAt(0);
  const last = word.charAt(word.length - 1);
  const checkStart = ASCII_WORD_CHAR.test(first);
  const checkEnd = ASCII_WORD_CHAR.test(last);
  for (
    let at = haystack.indexOf(word);
    at !== -1;
    at = haystack.indexOf(word, at + 1)
  ) {
    const before = haystack.charAt(at - 1);
    const after = haystack.charAt(at + word.length);
    if (
      (!checkStart || isBoundary(before)) &&
      (!checkEnd || isBoundary(after))
    ) {
      return true;
    }
  }
  return false;
}

/** True when one of the context words is within the window around `span`. */
export function hasContextWord(
  text: string,
  span: Span,
  context: ContextWords,
): boolean {
  // The two sides are searched separately so a phrase cannot be formed
  // across the candidate itself.
  const before = windowText(text, span.start - context.before, span.start);
  const after = windowText(text, span.end, span.end + context.after);
  return context.words.some(
    (word) => containsWord(before, word) || containsWord(after, word),
  );
}
