/**
 * Name pieces of an email's local part ("kai_hale92" → kai, hale), for the
 * names a reply derives from an address: asked to write to
 * kai_hale@example.org, a chatbot greets "Hi Hale,". The stand-in's pieces
 * are stored with the mapping (the vault's variants); the real pieces are
 * taken from the real address again after decryption, so nothing of the
 * real value is stored apart from the encrypted value.
 */
import { splitAddress } from './email-links.ts';

/** Separators of local-part pieces. */
const SEPARATORS = /[._+-]+/u;
const LETTERS = /^\p{L}{2,}$/u;

/**
 * Words a local part often holds that are not names, so a reply's ordinary
 * word is never taken for one: role words, mail words and short English
 * words.
 */
const COMMON_WORDS = new Set([
  'about',
  'account',
  'accounts',
  'admin',
  'all',
  'and',
  'bill',
  'billing',
  'booking',
  'can',
  'careers',
  'contact',
  'dear',
  'dev',
  'email',
  'enquiries',
  'for',
  'from',
  'general',
  'hello',
  'help',
  'here',
  'home',
  'info',
  'jobs',
  'mail',
  'marketing',
  'may',
  'news',
  'noreply',
  'not',
  'office',
  'orders',
  'our',
  'press',
  'reply',
  'sales',
  'service',
  'services',
  'shop',
  'support',
  'team',
  'the',
  'test',
  'this',
  'web',
  'webmaster',
  'will',
  'with',
  'work',
  'you',
  'your',
]);

/**
 * The pieces of an address's local part, in order, as written ("kai",
 * "hale92"); empty pieces (leading or doubled separators) are dropped.
 */
export function emailNameParts(email: string): string[] {
  const { local } = splitAddress(email);
  return local.split(SEPARATORS).filter((piece) => piece !== '');
}

/** A piece without its digits ("hale92" → "hale"). */
const withoutDigits = (piece: string): string => piece.replace(/\p{N}+/gu, '');

/**
 * Pairs of stand-in and real local-part pieces that look like names: same
 * number of pieces, letters only, two or more of them, not a common word,
 * and different from each other.
 */
export function derivedNamePairs(
  standInParts: readonly string[],
  realEmail: string,
): { standIn: string; real: string }[] {
  const realParts = emailNameParts(realEmail);
  if (realParts.length !== standInParts.length) return [];
  const pairs: { standIn: string; real: string }[] = [];
  for (const [i, piece] of standInParts.entries()) {
    const standIn = withoutDigits(piece);
    const real = withoutDigits(realParts[i] ?? '');
    if (!LETTERS.test(standIn) || !LETTERS.test(real)) continue;
    const key = standIn.toLowerCase();
    if (COMMON_WORDS.has(key) || key === real.toLowerCase()) continue;
    pairs.push({ standIn, real });
  }
  return pairs;
}
