/**
 * The bundled word-list files and how they are checked when loaded.
 *
 * - `<locale>.json` (LocaleWords): given names by gender, family names,
 *   legal suffixes, street types, localities and postcode templates of one
 *   locale.
 * - `names.json` (NameIndex): every name of every locale with the locales
 *   that list it, so a name's likely locale and gender can be inferred
 *   before that locale's file is loaded. Names are grouped by their flags:
 *   "female,male,neutral,family" masks → names joined by NAME_SEPARATOR.
 *
 * Postcode templates: `#` a digit, `?` an upper-case letter, `[…]` one of
 * the characters inside, anything else as written.
 */

import { runBlocking } from '../../detect/schedule.ts';

/** Changes whenever the files' shape changes; files must carry it. */
export const WORDLIST_VERSION = 2;

/** Separates the names of one group in `names.json`. */
export const NAME_SEPARATOR = '|';

/** Where a locale writes its street type (Road, Rue, straat). */
export type StreetTypeOrder = 'before' | 'after' | 'glued';

export interface LocaleWords {
  readonly version: number;
  readonly locale: string;
  readonly given: {
    readonly female: readonly string[];
    readonly male: readonly string[];
    /** Listed for both genders, or for neither. */
    readonly neutral: readonly string[];
  };
  readonly family: {
    readonly any: readonly string[];
    /** Languages with gendered family names (e.g. Russian). */
    readonly female: readonly string[];
    readonly male: readonly string[];
  };
  /** Legal forms and similar company suffixes (GmbH, Pty Ltd, S.A.). */
  readonly legal: readonly string[];
  readonly streetTypes: readonly string[];
  readonly streetTypeOrder: StreetTypeOrder;
  readonly localities: readonly string[];
  readonly postcodes: readonly string[];
}

/** Bit masks over NameIndex.locales: bit i is locales[i]. */
export interface NameFlags {
  readonly female: number;
  readonly male: number;
  readonly neutral: number;
  readonly family: number;
}

export interface NameIndex {
  readonly version: number;
  readonly locales: readonly string[];
  /** Lower-case name → [female, male, neutral, family] masks. */
  readonly names: ReadonlyMap<string, NameFlags>;
  /** Legal suffix as written → mask of the locales that use it. */
  readonly legal: ReadonlyMap<string, number>;
}

/** Thrown for a word-list file that does not have the expected shape. */
export class WordListError extends Error {
  constructor() {
    super('word-list');
    this.name = 'WordListError';
  }
}

type Fields = Record<string, unknown>;

function isObject(value: unknown): value is Fields {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function strings(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    !value.every((item): item is string => typeof item === 'string')
  ) {
    throw new WordListError();
  }
  return value;
}

function object(value: unknown): Fields {
  if (!isObject(value)) throw new WordListError();
  return value;
}

function isMask(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

/** Checks a loaded `<locale>.json`. */
export function parseLocaleWords(value: unknown, locale: string): LocaleWords {
  const file = object(value);
  if (file.version !== WORDLIST_VERSION || file.locale !== locale) {
    throw new WordListError();
  }
  const given = object(file.given);
  const family = object(file.family);
  const order = file.streetTypeOrder;
  if (order !== 'before' && order !== 'after' && order !== 'glued') {
    throw new WordListError();
  }
  return {
    version: WORDLIST_VERSION,
    locale,
    given: {
      female: strings(given.female),
      male: strings(given.male),
      neutral: strings(given.neutral),
    },
    family: {
      any: strings(family.any),
      female: strings(family.female),
      male: strings(family.male),
    },
    legal: strings(file.legal),
    streetTypes: strings(file.streetTypes),
    streetTypeOrder: order,
    localities: strings(file.localities),
    postcodes: strings(file.postcodes),
  };
}

/** Names per step of the sliced index build (well under a millisecond). */
const NAMES_PER_STEP = 500;

const FLAGS = /^(\d+),(\d+),(\d+),(\d+)$/u;

/**
 * Builds the index from a loaded `names.json` step by step, so the page's
 * main thread can be given back between steps (see runSliced): the file is
 * grouped by flags (one string of names per combination) because parsing
 * twenty thousand small arrays took 40 ms in one task on the target laptop.
 */
export function* nameIndexSteps(value: unknown): Generator<void, NameIndex> {
  const file = object(value);
  if (file.version !== WORDLIST_VERSION) throw new WordListError();
  const locales = strings(file.locales);
  if (locales.length > 31) throw new WordListError();
  const names = new Map<string, NameFlags>();
  let count = 0;
  for (const [key, list] of Object.entries(object(file.groups))) {
    const match = FLAGS.exec(key);
    if (match === null || typeof list !== 'string') throw new WordListError();
    const [female, male, neutral, family] = match.slice(1).map(Number);
    const flags: NameFlags = {
      female: female ?? 0,
      male: male ?? 0,
      neutral: neutral ?? 0,
      family: family ?? 0,
    };
    for (const name of list.split(NAME_SEPARATOR)) {
      names.set(name, flags);
      count += 1;
      if (count % NAMES_PER_STEP === 0) yield;
    }
  }
  const legal = new Map<string, number>();
  for (const [suffix, mask] of Object.entries(object(file.legal))) {
    if (!isMask(mask)) throw new WordListError();
    legal.set(suffix, mask);
  }
  return { version: WORDLIST_VERSION, locales, names, legal };
}

/** Checks a loaded `names.json` in one go (tests and scripts). */
export function parseNameIndex(value: unknown): NameIndex {
  return runBlocking(nameIndexSteps(value));
}
