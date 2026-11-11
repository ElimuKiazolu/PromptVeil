/**
 * Format preservation: a stand-in is written exactly like the real value.
 * Generators produce the stand-in's letters and digits in order; every
 * other character of the real value (spaces, hyphens, dots, brackets, "+",
 * prefixes) is copied as it is, and each letter takes the case the real
 * value had at that position.
 */

function isAsciiAlphanumeric(char: string): boolean {
  return /^[A-Za-z0-9]$/u.test(char);
}

/** The letters and digits of a written value, in order. */
export function alphanumerics(written: string): string {
  let out = '';
  for (const char of written) if (isAsciiAlphanumeric(char)) out += char;
  return out;
}

/**
 * `written` with its letters and digits replaced, in order, by
 * `characters` (one for one). Throws when the counts differ.
 */
export function applyLayout(written: string, characters: string): string {
  if (alphanumerics(written).length !== characters.length) {
    throw new RangeError('layout length');
  }
  let out = '';
  let next = 0;
  for (const char of written) {
    if (!isAsciiAlphanumeric(char)) {
      out += char;
      continue;
    }
    const replacement = characters.charAt(next);
    next += 1;
    out += /^[a-z]$/u.test(char)
      ? replacement.toLowerCase()
      : replacement.toUpperCase();
  }
  return out;
}

/** Lower case, letters and digits only: how stand-ins are compared to text. */
export function compactForm(value: string): string {
  return alphanumerics(value).toLowerCase();
}
