/**
 * How person names are taken apart, for PERSON stand-ins and for restoring
 * single name parts (the real name and its stand-in are split the same way,
 * and their parts pair up by position).
 *
 * A name is leading titles (kept), then pieces: runs of letters (with
 * apostrophes, and a dot after an initial). Pieces are names, initials
 * ("J."), or particles (de, van, bin), which are kept like titles. Words are
 * separated by spaces or commas; hyphens join pieces into one word.
 */
import type { NameIndex } from '../surrogate/words/format.ts';
import { scriptOf, type Script } from './script.ts';
import { titlePrefixLength } from './titles.ts';

/** Scripts whose names are written family name first. */
export const CJK: ReadonlySet<Script> = new Set<Script>([
  'han',
  'japanese',
  'hangul',
]);

export type PieceKind = 'name' | 'initial' | 'particle';

export interface NamePiece {
  readonly start: number;
  readonly end: number;
  readonly text: string;
  readonly kind: PieceKind;
  /** The word the piece belongs to (hyphenated pieces share one). */
  readonly word: number;
}

export interface ParsedName {
  /** End of the leading titles (0 without). */
  readonly titleEnd: number;
  readonly pieces: readonly NamePiece[];
}

export type Gender = 'female' | 'male';

/** Particles kept as written (lower case or capitalised). */
const PARTICLES = new Set([
  'af',
  'al',
  'av',
  'bin',
  'binti',
  'da',
  'das',
  'de',
  'degli',
  'dei',
  'del',
  'della',
  'delle',
  'den',
  'der',
  'des',
  'di',
  'do',
  'dos',
  'du',
  'e',
  'el',
  'ibn',
  'la',
  'le',
  'ten',
  'ter',
  'van',
  'vom',
  'von',
  'y',
  'zu',
  'zum',
  'zur',
]);

const PIECE = /[\p{L}\p{M}'’]+\.?/gu;
const WORD_BREAK = /[\s,]/u;
const INITIAL = /^\p{L}\.?$/u;

export function parseName(value: string): ParsedName {
  const titleEnd = titlePrefixLength(value);
  const found: { start: number; end: number; text: string; word: number }[] =
    [];
  let word = -1;
  let last = titleEnd;
  PIECE.lastIndex = titleEnd;
  for (
    let match = PIECE.exec(value);
    match !== null;
    match = PIECE.exec(value)
  ) {
    const between = value.slice(last, match.index);
    if (word < 0 || WORD_BREAK.test(between)) word += 1;
    found.push({
      start: match.index,
      end: match.index + match[0].length,
      text: match[0],
      word,
    });
    last = match.index + match[0].length;
  }
  const pieces = found.map((piece, position): NamePiece => {
    const kind: PieceKind = INITIAL.test(piece.text)
      ? 'initial'
      : PARTICLES.has(piece.text.toLowerCase()) &&
          position < found.length - 1 &&
          found.length > 1
        ? 'particle'
        : 'name';
    return { ...piece, kind };
  });
  return { titleEnd, pieces };
}

/** The name pieces (no titles, particles or initials), in order. */
export function nameParts(value: string): string[] {
  return parseName(value)
    .pieces.filter((piece) => piece.kind === 'name')
    .map((piece) => piece.text);
}

const FEMALE_TITLES = new Set([
  'mrs',
  'ms',
  'miss',
  'frau',
  'sra',
  'srta',
  'dra',
  'smt',
  'mme',
  'mlle',
]);
const MALE_TITLES = new Set(['mr', 'herr', 'sr', 'shri', 'm']);

/** The gender a name's titles state, if any. */
export function titleGender(value: string, parsed: ParsedName): Gender | null {
  const titles = value
    .slice(0, parsed.titleEnd)
    .toLowerCase()
    .split(/[\s.]+/u)
    .filter((title) => title !== '');
  for (const title of titles) {
    if (FEMALE_TITLES.has(title)) return 'female';
    if (MALE_TITLES.has(title)) return 'male';
  }
  return null;
}

/** Lower case, accents removed: how names are looked up in the index. */
export function foldName(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .normalize('NFC');
}

export interface IndexHit {
  readonly given: number;
  readonly family: number;
  readonly female: number;
  readonly male: number;
}

const NO_HIT: IndexHit = { given: 0, family: 0, female: 0, male: 0 };

/** The locales listing the name, as given or family name (bit masks). */
export function lookUpName(
  index: NameIndex | undefined,
  name: string,
): IndexHit {
  if (index === undefined) return NO_HIT;
  const flags =
    index.names.get(name.toLowerCase()) ?? index.names.get(foldName(name));
  if (flags === undefined) return NO_HIT;
  return {
    given: flags.female | flags.male | flags.neutral,
    family: flags.family,
    female: flags.female,
    male: flags.male,
  };
}

export type Role = 'given' | 'family';

/**
 * Word lists whose names are written family name first in Latin letters:
 * Chinese names in pinyin ("Wang Wei") and Singaporean names ("Lim Boon
 * Keng").
 */
const FAMILY_FIRST_LOCALES: readonly string[] = ['zh_Latn', 'en_SG'];

/**
 * True when a family-first list reads the name that way: it knows the first
 * word as a family name and each other word as one of its given names or
 * as no list's given name (Chinese given syllables are often surnames too:
 * "Boon" in "Lim Boon Keng"), and no other list knows the first word as a
 * given name ("Lee Morgan" stays given name first). Two pinyin surnames
 * ("Wei Wang") are read family first, as Chinese writes them.
 */
function familyFirstByList(
  index: NameIndex | undefined,
  first: string,
  others: readonly string[],
): boolean {
  if (index === undefined) return false;
  const firstHit = lookUpName(index, first);
  const familyFirstMask = FAMILY_FIRST_LOCALES.reduce((mask, id) => {
    const bit = index.locales.indexOf(id);
    return bit < 0 ? mask : mask | (1 << bit);
  }, 0);
  if ((firstHit.given & ~familyFirstMask) !== 0) return false;
  return FAMILY_FIRST_LOCALES.some((id) => {
    const bit = index.locales.indexOf(id);
    if (bit < 0) return false;
    const mask = 1 << bit;
    return (
      (firstHit.family & mask) !== 0 &&
      others.every((word) => {
        const hit = lookUpName(index, word);
        return (hit.given & mask) !== 0 || hit.given === 0;
      })
    );
  });
}

const isUpperWord = (text: string): boolean =>
  text.length > 1 && text === text.toUpperCase() && text !== text.toLowerCase();

/**
 * The role of each name piece (same order as nameParts): the last name word
 * is the family name and earlier ones are given names, unless the name is
 * written family first: CJK names with spaces, a comma after the first word
 * ("Pemberton, Harriet"), a first word in capitals before ones that are not
 * ("DUPONT Jean"), a first word that the lists know only as a family name
 * before a last word they know only as a given name, or a name a
 * family-first list reads that way (see familyFirstByList). A single word is a
 * family name only when the lists know it only as one.
 */
export function rolesOf(
  value: string,
  parsed: ParsedName,
  index: NameIndex | undefined,
): Role[] {
  const names = parsed.pieces.filter((piece) => piece.kind === 'name');
  const words = [...new Set(names.map((piece) => piece.word))];
  const firstWord = words[0];
  const lastWord = words[words.length - 1];
  if (firstWord === undefined || lastWord === undefined) return [];
  const textOf = (word: number): string =>
    names
      .filter((piece) => piece.word === word)
      .map((piece) => piece.text)
      .join('-');
  const onlyFamily = (word: number): boolean => {
    const hit = lookUpName(index, textOf(word));
    return hit.family !== 0 && hit.given === 0;
  };
  const onlyGiven = (word: number): boolean => {
    const hit = lookUpName(index, textOf(word));
    return hit.given !== 0 && hit.family === 0;
  };
  if (words.length === 1) {
    const role: Role = onlyFamily(firstWord) ? 'family' : 'given';
    return names.map(() => role);
  }
  const firstPiece = names[0];
  const afterFirst = names.find((piece) => piece.word !== firstWord);
  const commaAfterFirst =
    firstPiece !== undefined &&
    afterFirst !== undefined &&
    value.slice(firstPiece.end, afterFirst.start).includes(',');
  const familyFirst =
    CJK.has(scriptOf(value)) ||
    commaAfterFirst ||
    (isUpperWord(textOf(firstWord)) &&
      words.slice(1).some((word) => !isUpperWord(textOf(word)))) ||
    (onlyFamily(firstWord) && onlyGiven(lastWord)) ||
    familyFirstByList(index, textOf(firstWord), words.slice(1).map(textOf));
  const familyWord = familyFirst ? firstWord : lastWord;
  return names.map((piece) => (piece.word === familyWord ? 'family' : 'given'));
}

/** Writes `text` in the case style of `like` (capitals, lower case or as is). */
export function inCaseOf(like: string, text: string): string {
  if (isUpperWord(like)) return text.toUpperCase();
  if (like === like.toLowerCase() && like !== like.toUpperCase()) {
    return text.toLowerCase();
  }
  // Capitalised, and the word is in lower case: capitalise it too.
  const first = like.charAt(0);
  if (first !== first.toLowerCase() && text === text.toLowerCase()) {
    return text.charAt(0).toUpperCase() + text.slice(1);
  }
  return text;
}
