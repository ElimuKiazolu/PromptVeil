/**
 * Which locale's lists a stand-in comes from, and a name's gender.
 *
 * Locale: only locales written in the value's script qualify (a name in
 * Latin letters never gets one in Chinese characters). Each scores a point
 * per given-name piece its lists have as a given name and per family-name
 * piece they have as a family name; the highest score wins, ties going to
 * the preferred locales (home regions, then browser languages), then to
 * LOCALES order. Nothing known: the first preferred locale of that script,
 * else the first locale of that script.
 */
import { lookUpName, type Gender, type Role } from '../../names/parts.ts';
import type { NameIndex } from './format.ts';
import {
  fitsScript,
  LOCALES,
  type LocaleId,
  type LocaleInfo,
  type Script,
} from './locales.ts';

/** One looked-up piece and the role it plays. */
export interface ScoredPiece {
  readonly text: string;
  readonly role: Role;
}

function bitOf(index: NameIndex | undefined, locale: LocaleId): number {
  const position = index?.locales.indexOf(locale) ?? -1;
  return position < 0 ? 0 : 2 ** position;
}

function has(mask: number, bit: number): boolean {
  return bit !== 0 && Math.floor(mask / bit) % 2 === 1;
}

/** Locales of the script, preferred ones first, then in LOCALES order. */
export function rankedLocales(
  script: Script,
  preferred: readonly LocaleId[],
): LocaleInfo[] {
  const rank = (locale: LocaleInfo): number => {
    const position = preferred.indexOf(locale.id);
    return position < 0 ? preferred.length : position;
  };
  return LOCALES.filter((locale) => fitsScript(locale, script)).sort(
    (a, b) => rank(a) - rank(b),
  );
}

/** The best locale for these pieces (see the module comment). */
export function inferLocale(
  script: Script,
  pieces: readonly ScoredPiece[],
  index: NameIndex | undefined,
  preferred: readonly LocaleId[],
): LocaleId {
  const ranked = rankedLocales(script, preferred);
  let best: LocaleId | null = null;
  let bestScore = 0;
  for (const locale of ranked) {
    const bit = bitOf(index, locale.id);
    let score = 0;
    for (const piece of pieces) {
      const hit = lookUpName(index, piece.text);
      if (has(piece.role === 'given' ? hit.given : hit.family, bit)) score += 1;
    }
    if (score > bestScore) {
      best = locale.id;
      bestScore = score;
    }
  }
  return best ?? ranked[0]?.id ?? 'en_US';
}

/** The gender the locale's lists give the given name, if only one. */
export function genderOf(
  index: NameIndex | undefined,
  locale: LocaleId,
  name: string,
): Gender | null {
  const bit = bitOf(index, locale);
  const hit = lookUpName(index, name);
  const female = has(hit.female, bit);
  const male = has(hit.male, bit);
  if (female === male) return null;
  return female ? 'female' : 'male';
}

/** True when the locale's lists have the name in that role. */
export function listedAs(
  index: NameIndex | undefined,
  locale: LocaleId,
  name: string,
  role: Role,
): boolean {
  const hit = lookUpName(index, name);
  return has(role === 'given' ? hit.given : hit.family, bitOf(index, locale));
}

/** The preferred locale among those whose bit is set in `mask`. */
export function preferredIn(
  index: NameIndex | undefined,
  mask: number,
  preferred: readonly LocaleId[],
): LocaleId | null {
  if (index === undefined || mask === 0) return null;
  for (const locale of rankedLocales('latin', preferred)) {
    if (has(mask, bitOf(index, locale.id))) return locale.id;
  }
  for (const locale of LOCALES) {
    if (has(mask, bitOf(index, locale.id))) return locale.id;
  }
  return null;
}
