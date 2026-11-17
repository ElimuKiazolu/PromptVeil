/**
 * The bundled word lists (public/data/) read from disk, for tests that make
 * stand-ins needing them (PERSON, ORG, ADDRESS, EMAIL).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { StandInEngine, StandInFactory } from '@/src/core/pipeline.ts';
import { generateStandIn } from '@/src/core/surrogate/engine.ts';
import type { StandInEnvironment } from '@/src/core/surrogate/types.ts';
import {
  parseLocaleWords,
  parseNameIndex,
  type LocaleWords,
  type NameIndex,
} from '@/src/core/surrogate/words/format.ts';
import { LOCALES, type LocaleId } from '@/src/core/surrogate/words/locales.ts';
import { fixedWordLists } from '@/src/core/surrogate/words/store.ts';

/**
 * Tests run from the extension directory (both projects; jsdom's
 * import.meta.url is not a file URL).
 */
export const WORD_DATA = join(process.cwd(), 'public', 'data');

/** One bundled file, parsed JSON. */
export function readWordFile(name: string): unknown {
  return JSON.parse(readFileSync(join(WORD_DATA, `${name}.json`), 'utf8'));
}

/** A loader like the content script's, reading from disk. */
export const diskWordLoader = (name: string): Promise<unknown> =>
  Promise.resolve().then(() => readWordFile(name));

let index: NameIndex | undefined;
const locales = new Map<LocaleId, LocaleWords>();

export function nameIndex(): NameIndex {
  index ??= parseNameIndex(readWordFile('names'));
  return index;
}

export function localeWords(id: LocaleId): LocaleWords {
  let words = locales.get(id);
  if (words === undefined) {
    words = parseLocaleWords(readWordFile(id), id);
    locales.set(id, words);
  }
  return words;
}

/** Every list loaded; home locales as given. */
export function testEnv(
  options: { preferred?: readonly LocaleId[]; keepCity?: boolean } = {},
): StandInEnvironment {
  return {
    words: fixedWordLists(
      nameIndex(),
      LOCALES.map((locale) => localeWords(locale.id)),
    ),
    preferredLocales: options.preferred ?? ['en_GB'],
    keepCity: options.keepCity ?? true,
  };
}

/** The production engine over every list. */
export function testEngine(env: StandInEnvironment = testEnv()): StandInEngine {
  return {
    load: () => Promise.resolve(),
    standIn: (request, seed, attempt) =>
      generateStandIn(request, seed, attempt, env),
  };
}

/** A factory as an engine that needs no word lists. */
export function asEngine(standIn: StandInFactory): StandInEngine {
  return { load: () => Promise.resolve(), standIn };
}
