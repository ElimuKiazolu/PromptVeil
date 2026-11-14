/**
 * The compact form the request safety net compares: letters and digits only,
 * lower case, after NFKC (so full-width digits and letters count as ASCII).
 * Spaced, unspaced, hyphenated, dotted or differently cased writings of a
 * value share one compact form.
 *
 * It runs in both worlds: the isolated side computes the forms of masked
 * values, the page-world net computes the compact form of request text.
 */

/** Forms shorter than this are not checked: they would match unrelated text. */
export const MIN_FORM_LENGTH = 6;

function isAsciiAlphanumeric(code: number): boolean {
  return (
    (code >= 48 && code <= 57) ||
    (code >= 97 && code <= 122) ||
    (code >= 65 && code <= 90)
  );
}

const LETTER_OR_NUMBER = /^[\p{L}\p{N}]$/u;

export function compactForm(text: string): string {
  const normalised = text.normalize('NFKC').toLowerCase();
  let out = '';
  for (let i = 0; i < normalised.length; i += 1) {
    const code = normalised.charCodeAt(i);
    if (code < 128) {
      if (isAsciiAlphanumeric(code)) out += normalised.charAt(i);
      continue;
    }
    // Code points outside the BMP come as surrogate pairs.
    const char = String.fromCodePoint(normalised.codePointAt(i) ?? code);
    if (char.length === 2) i += 1;
    if (LETTER_OR_NUMBER.test(char)) out += char;
  }
  return out;
}
