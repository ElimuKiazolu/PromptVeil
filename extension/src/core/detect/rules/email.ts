import type { Detection } from '../../../shared/entities.ts';
import { finding, type Rule } from './types.ts';
import {
  MAX_EMAIL_ADDRESS,
  MAX_EMAIL_DOMAIN,
  MAX_EMAIL_LOCAL,
  isEmailDomainChar,
  isEmailLocalChar,
  isEmailLocalStart,
  isValidEmailDomain,
} from '../validators/email.ts';

/** Local part immediately before index `at`, or null if there is none. */
function localPartStart(text: string, at: number): number | null {
  let start = at;
  // Scan one character past the limit so over-long runs can be rejected.
  while (
    start > 0 &&
    at - start <= MAX_EMAIL_LOCAL &&
    isEmailLocalChar(text.charAt(start - 1))
  ) {
    start -= 1;
  }
  if (at - start > MAX_EMAIL_LOCAL) return null;

  // Text after a double dot is the address; anything before it is not.
  const doubleDot = text.slice(start, at).lastIndexOf('..');
  if (doubleDot !== -1) start += doubleDot + 2;
  // Leading punctuation (quotes, dashes, dots) belongs to the surrounding text.
  while (start < at && !isEmailLocalStart(text.charAt(start))) start += 1;

  if (start === at || text.charAt(at - 1) === '.') return null;
  return start;
}

/** End of a valid domain starting at `from`, or null if there is none. */
function domainEnd(text: string, from: number): number | null {
  let end = from;
  while (
    end < text.length &&
    end - from <= MAX_EMAIL_DOMAIN &&
    isEmailDomainChar(text.charAt(end))
  ) {
    end += 1;
  }
  const doubleDot = text.slice(from, end).indexOf('..');
  if (doubleDot !== -1) end = from + doubleDot;
  // A trailing full stop or hyphen belongs to the sentence, not the domain.
  while (end > from && /[.-]/.test(text.charAt(end - 1))) end -= 1;
  if (end - from > MAX_EMAIL_DOMAIN) return null;
  return isValidEmailDomain(text.slice(from, end)) ? end : null;
}

/**
 * Finds email addresses in free text.
 *
 * Works outward from each "@" with bounded scans, so the cost stays linear in
 * the input length however the text is shaped.
 */
export function detectEmails(text: string): Detection[] {
  const found: Detection[] = [];
  let lastEnd = 0;
  for (let at = text.indexOf('@'); at !== -1; at = text.indexOf('@', at + 1)) {
    const start = localPartStart(text, at);
    if (start === null || start < lastEnd) continue;
    const end = domainEnd(text, at + 1);
    if (end === null || end - start > MAX_EMAIL_ADDRESS) continue;
    found.push({
      type: 'EMAIL',
      subtype: null,
      country: null,
      start,
      end,
      value: text.slice(start, end),
      confidence: 1,
      validated: true,
      source: 'rule',
      status: 'confirmed',
      alternatives: [],
    });
    lastEnd = end;
  }
  return found;
}

/** Global EMAIL rule: the scan above already validates each address. */
export const EMAIL_RULE: Rule = {
  id: 'global.email',
  type: 'EMAIL',
  subtype: null,
  country: null,
  find: (text) => detectEmails(text),
  validate() {
    return finding(EMAIL_RULE, 'structural');
  },
  context: null,
  contextRequired: false,
  negativeContext: [],
  confidence: { validated: 1, context: 1, none: 1 },
};
