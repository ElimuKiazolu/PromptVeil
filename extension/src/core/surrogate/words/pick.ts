/**
 * Drawing words for stand-ins: from the right list for the role and
 * gender, never a word to avoid (the real one, or one already used in the
 * same stand-in).
 */
import type { Gender } from '../../names/parts.ts';
import type { Rng } from '../rng.ts';
import type { StandInEnvironment } from '../types.ts';
import { WordListError, type LocaleWords } from './format.ts';
import type { LocaleId } from './locales.ts';

/** Draws before giving up on finding a word not to avoid. */
const TRIES = 32;

/** The locale's lists; throws when they are not loaded (fail closed). */
export function wordsOf(
  env: StandInEnvironment,
  locale: LocaleId,
): LocaleWords {
  const words = env.words.locale(locale);
  if (words === undefined) throw new WordListError();
  return words;
}

/**
 * A word of `list` whose lower case form is not in `avoid` (and, when
 * given, has `length` characters if any has); null for an empty list or
 * when every draw hits a word to avoid.
 */
export function pickWord(
  rng: Rng,
  list: readonly string[],
  avoid: ReadonlySet<string>,
  length?: number,
): string | null {
  const sized =
    length === undefined
      ? list
      : list.filter((word) => Array.from(word).length === length);
  const from = sized.length > 0 ? sized : list;
  if (from.length === 0) return null;
  for (let i = 0; i < TRIES; i += 1) {
    const word = rng.pick(from);
    if (!avoid.has(word.toLowerCase())) return word;
  }
  return null;
}

export function givenNames(
  words: LocaleWords,
  gender: Gender | null,
): readonly string[] {
  const { female, male, neutral } = words.given;
  if (gender === 'female' && female.length > 0) return [...female, ...neutral];
  if (gender === 'male' && male.length > 0) return [...male, ...neutral];
  return [...female, ...male, ...neutral];
}

export function familyNames(
  words: LocaleWords,
  gender: Gender | null,
): readonly string[] {
  const { any, female, male } = words.family;
  if (gender === 'female' && female.length > 0) return female;
  if (gender === 'male' && male.length > 0) return male;
  if (any.length > 0) return any;
  return [...female, ...male];
}
