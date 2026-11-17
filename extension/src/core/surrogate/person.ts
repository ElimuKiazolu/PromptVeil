/**
 * PERSON stand-ins (TR-S2): the same titles, particles and number of name
 * parts, each part replaced by a name of the same role (given or family)
 * from the locale the name most likely comes from, keeping the gender where
 * a title or the first given name shows it. Initials stay initials, each
 * part keeps its case style (DUPONT stays in capitals), and hyphens, commas
 * and spaces stay where they were.
 *
 * A CJK name written without spaces (王伟) is split into a family name
 * known to the lists and the given name, and both are replaced by names of
 * the same lengths where the lists have them.
 */
import {
  CJK,
  inCaseOf,
  lookUpName,
  parseName,
  rolesOf,
  titleGender,
  type Gender,
  type NamePiece,
  type ParsedName,
  type Role,
} from '../names/parts.ts';
import { UPPER } from './rng.ts';
import type { Rng } from './rng.ts';
import type { NameIndex } from './words/format.ts';
import { genderOf, inferLocale, type ScoredPiece } from './words/infer.ts';
import { scriptOf, type LocaleId } from './words/locales.ts';
import { familyNames, givenNames, pickWord, wordsOf } from './words/pick.ts';
import type { Generator, StandInEnvironment } from './types.ts';

/** A CJK name written as one piece: where the family name ends. */
function cjkSplit(text: string, index: NameIndex | undefined): number {
  const chars = Array.from(text);
  for (const length of [2, 1]) {
    if (chars.length > length) {
      const family = chars.slice(0, length).join('');
      if (lookUpName(index, family).family !== 0) return length;
    }
  }
  return 1;
}

interface PersonPlan {
  readonly parsed: ParsedName;
  readonly names: readonly NamePiece[];
  readonly roles: readonly Role[];
  /** For a one-piece CJK name: the family name's length in characters. */
  readonly cjkFamily: number | null;
  readonly locale: LocaleId;
}

/** Titles that show a language: their locale wins a tie. */
const TITLE_LOCALES = new Map<string, LocaleId>([
  ['herr', 'de'],
  ['frau', 'de'],
  ['m', 'fr'],
  ['mme', 'fr'],
  ['mlle', 'fr'],
  ['sr', 'es'],
  ['sra', 'es'],
  ['srta', 'es'],
  ['dra', 'es'],
  ['shri', 'en_IN'],
  ['smt', 'en_IN'],
  ['sri', 'en_IN'],
]);

function titleLocale(value: string, parsed: ParsedName): LocaleId | null {
  for (const title of value
    .slice(0, parsed.titleEnd)
    .toLowerCase()
    .split(/[\s.]+/u)) {
    const locale = TITLE_LOCALES.get(title);
    if (locale !== undefined) return locale;
  }
  return null;
}

function planPerson(
  value: string,
  index: NameIndex | undefined,
  homePreferred: readonly LocaleId[],
): PersonPlan {
  const parsed = parseName(value);
  const hinted = titleLocale(value, parsed);
  const preferred =
    hinted === null ? homePreferred : [hinted, ...homePreferred];
  const names = parsed.pieces.filter((piece) => piece.kind === 'name');
  const script = scriptOf(value);
  const only = names.length === 1 ? names[0] : undefined;
  if (
    only !== undefined &&
    CJK.has(script) &&
    Array.from(only.text).length > 1
  ) {
    const split = cjkSplit(only.text, index);
    const chars = Array.from(only.text);
    const pieces: ScoredPiece[] = [
      { text: chars.slice(0, split).join(''), role: 'family' },
      { text: chars.slice(split).join(''), role: 'given' },
    ];
    return {
      parsed,
      names,
      roles: ['family'],
      cjkFamily: split,
      locale: inferLocale(script, pieces, index, preferred),
    };
  }
  const roles = rolesOf(value, parsed, index);
  const pieces = names.map((piece, position) => ({
    text: piece.text,
    role: roles[position] ?? 'given',
  }));
  return {
    parsed,
    names,
    roles,
    cjkFamily: null,
    locale: inferLocale(script, pieces, index, preferred),
  };
}

/** The locale a PERSON stand-in for `value` comes from. */
export function personLocale(
  value: string,
  index: NameIndex | undefined,
  preferred: readonly LocaleId[],
): LocaleId {
  return planPerson(value, index, preferred).locale;
}

function genderFor(
  value: string,
  plan: PersonPlan,
  index: NameIndex | undefined,
): Gender | null {
  const fromTitle = titleGender(value, plan.parsed);
  if (fromTitle !== null) return fromTitle;
  const firstGiven = plan.names.find(
    (_, position) => plan.roles[position] === 'given',
  );
  if (firstGiven !== undefined) {
    return genderOf(index, plan.locale, firstGiven.text);
  }
  if (plan.cjkFamily !== null) {
    const given = Array.from(plan.names[0]?.text ?? '')
      .slice(plan.cjkFamily)
      .join('');
    return genderOf(index, plan.locale, given);
  }
  return null;
}

/** One piece that parses as a name: letters, at most one apostrophe. */
const SINGLE_PIECE = /^[\p{L}\p{M}]{2,}(?:['’][\p{L}\p{M}]+)?$/u;

/** CJK names are one run of characters; a family name may be one. */
const isCjkNameWord = (word: string): boolean => /^[\p{L}\p{M}]+$/u.test(word);

const isNameWord = (word: string): boolean =>
  SINGLE_PIECE.test(word) && parseName(word).pieces[0]?.kind === 'name';

/** An initial of the same script: a Latin letter, else a given name's first. */
function initialFor(rng: Rng, piece: string, names: readonly string[]): string {
  const letter = Array.from(piece)[0] ?? '';
  const latin = /^[A-Za-z]$/u.test(letter);
  let replacement = letter;
  for (
    let i = 0;
    i < 32 && replacement.toUpperCase() === letter.toUpperCase();
    i += 1
  ) {
    replacement = latin
      ? rng.char(UPPER)
      : (Array.from(rng.pick(names))[0] ?? letter);
  }
  const cased =
    letter === letter.toLowerCase() ? replacement.toLowerCase() : replacement;
  return cased + piece.slice(letter.length);
}

/**
 * The stand-in for a person's name, or null when the lists cannot give
 * different names (the next attempt draws again).
 */
export function personName(
  value: string,
  rng: Rng,
  env: StandInEnvironment,
): { value: string; locale: LocaleId } | null {
  const index = env.words.index();
  const plan = planPerson(value, index, env.preferredLocales);
  const words = wordsOf(env, plan.locale);
  const gender = genderFor(value, plan, index);
  const avoid = new Set(plan.names.map((piece) => piece.text.toLowerCase()));

  const fits = plan.cjkFamily === null ? isNameWord : isCjkNameWord;
  const draw = (role: Role, length?: number): string | null => {
    const list = (
      role === 'given' ? givenNames(words, gender) : familyNames(words, gender)
    ).filter(fits);
    const word = pickWord(rng, list, avoid, length);
    if (word !== null) avoid.add(word.toLowerCase());
    return word;
  };

  let out = '';
  let cursor = 0;
  let position = 0;
  for (const piece of plan.parsed.pieces) {
    out += value.slice(cursor, piece.start);
    cursor = piece.end;
    if (piece.kind === 'particle') {
      out += piece.text;
      continue;
    }
    if (piece.kind === 'initial') {
      out += initialFor(rng, piece.text, givenNames(words, null));
      continue;
    }
    const role = plan.roles[position] ?? 'given';
    position += 1;
    if (plan.cjkFamily !== null) {
      const chars = Array.from(piece.text);
      avoid.add(chars.slice(0, plan.cjkFamily).join(''));
      avoid.add(chars.slice(plan.cjkFamily).join(''));
      const family = draw('family', plan.cjkFamily);
      const given = draw('given', chars.length - plan.cjkFamily);
      if (family === null || given === null) return null;
      out += family + given;
      continue;
    }
    const word = draw(role);
    if (word === null) return null;
    out += inCaseOf(piece.text, word);
  }
  return { value: out + value.slice(cursor), locale: plan.locale };
}

export const personStandIn: Generator = ({ request, rng, env }) => {
  const name = personName(request.value, rng, env);
  return name === null
    ? null
    : { value: name.value, reserved: false, locale: name.locale };
};

/**
 * Same titles, the same pieces in the same kinds and words (a CJK name of
 * one piece stays one piece).
 */
export function isWellFormedPersonStandIn(
  standIn: string,
  real: string,
): boolean {
  const a = parseName(standIn);
  const b = parseName(real);
  return (
    standIn.slice(0, a.titleEnd) === real.slice(0, b.titleEnd) &&
    a.pieces.length === b.pieces.length &&
    a.pieces.every((piece, position) => {
      const other = b.pieces[position];
      return piece.kind === other?.kind && piece.word === other.word;
    })
  );
}
