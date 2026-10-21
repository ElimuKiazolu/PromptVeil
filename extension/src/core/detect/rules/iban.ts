/**
 * Global BANK / IBAN rule. A candidate starts with a country code and two
 * check digits at a word boundary; the scanner then reads exactly the number
 * of characters the IBAN registry gives for that country, allowing single
 * spaces or hyphens between them (the validator rejects mixed or irregular
 * grouping), so it never runs past the IBAN into the following words.
 */
import { isCountryCode } from '../../../shared/country.ts';
import type { Span } from '../text.ts';
import { IBAN_LENGTHS, validateIban } from '../validators/iban.ts';
import { INVALID, finding, type Rule } from './types.ts';

const IBAN_START = /[A-Za-z]{2}\d{2}/gu;
const WORD_CHAR = /^[\p{L}\p{N}_]$/u;

function isAsciiAlphanumeric(char: string): boolean {
  return /^[A-Za-z0-9]$/u.test(char);
}

export function* findIbanCandidates(text: string): Generator<Span> {
  // A copy per scan: the scan moves lastIndex past each candidate.
  const starts = new RegExp(IBAN_START.source, IBAN_START.flags);
  let lastEnd = -1;
  for (
    let match = starts.exec(text);
    match !== null;
    match = starts.exec(text)
  ) {
    const start = match.index;
    // Starts at a word boundary, or right where the previous IBAN ended.
    if (start !== lastEnd && WORD_CHAR.test(text.charAt(start - 1))) continue;
    const country = match[0].slice(0, 2).toUpperCase();
    const length = isCountryCode(country) ? IBAN_LENGTHS[country] : undefined;
    if (length === undefined) continue;
    let at = start + 4;
    let read = 4;
    while (read < length && at < text.length) {
      const char = text.charAt(at);
      if (isAsciiAlphanumeric(char)) {
        read += 1;
        at += 1;
      } else if (
        (char === ' ' || char === '-') &&
        isAsciiAlphanumeric(text.charAt(at + 1))
      ) {
        at += 1;
      } else {
        break;
      }
    }
    // No boundary is needed after the last character: the length is fixed
    // by the country and mod-97 rejects chance matches, so an IBAN glued to
    // the next value (another IBAN, a reference) is still found.
    if (read === length) {
      yield { start, end: at };
      starts.lastIndex = at;
      lastEnd = at;
    }
  }
}

export const IBAN_RULE: Rule = {
  id: 'global.iban',
  type: 'BANK',
  subtype: 'IBAN',
  country: null,
  find: findIbanCandidates,
  validate(value) {
    const result = validateIban(value);
    if (!result.valid) return INVALID;
    return finding(IBAN_RULE, 'checksum', { country: result.country });
  },
  context: {
    words: ['iban', 'account', 'bank', 'transfer', 'bic', 'swift'],
    before: 40,
    after: 16,
  },
  contextRequired: false,
  negativeContext: [],
  confidence: { validated: 1, context: 1, none: 1 },
};
