/**
 * Separator handling shared by the validators. A grouped value uses one kind
 * of separator throughout ("4242 4242 4242 4242" or "4242-4242-4242-4242"),
 * single separators only, and none at either end.
 */

/** Characters accepted between groups of a grouped number. */
export type Separator = ' ' | '-';

/**
 * The value without its separators, or null if they are mixed, doubled or
 * at either end. Values without separators are returned unchanged.
 */
export function stripGroupSeparators(
  value: string,
  allowed: readonly Separator[],
): string | null {
  let used: string | null = null;
  let out = '';
  for (let i = 0; i < value.length; i += 1) {
    const char = value.charAt(i);
    if (!(allowed as readonly string[]).includes(char)) {
      out += char;
      continue;
    }
    if (used !== null && char !== used) return null;
    used = char;
    const atEnd = i === 0 || i === value.length - 1;
    if (atEnd || value.charAt(i + 1) === char) return null;
  }
  return out;
}

/** Removes spaces, hyphens, dots and slashes (vault form of numeric values). */
export function removeNumericSeparators(value: string): string {
  return value.replace(/[\s./-]/gu, '');
}
