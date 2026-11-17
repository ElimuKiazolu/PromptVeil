/**
 * The word lists in memory: each file is loaded once, when a stand-in first
 * needs it, through a loader the content script provides (the files are
 * part of the extension package, so nothing leaves the device). Generators
 * read the lists synchronously; the pipeline loads what a send needs first.
 *
 * A failed load is not cached: it rejects (the send is blocked) and the next
 * send tries again.
 */
import {
  parseLocaleWords,
  nameIndexSteps,
  WordListError,
  type LocaleWords,
  type NameIndex,
} from './format.ts';
import { localeInfo, NAME_INDEX, type LocaleId } from './locales.ts';
import {
  blockingCheckpoint,
  runSliced,
  type Checkpoint,
} from '../../detect/schedule.ts';

/** Reads one bundled file (`names` or a locale id) as parsed JSON. */
export type WordLoader = (name: string) => Promise<unknown>;

/** The lists loaded so far. */
export interface WordLists {
  index(): NameIndex | undefined;
  locale(id: LocaleId): LocaleWords | undefined;
}

export interface WordStore extends WordLists {
  loadIndex(): Promise<NameIndex>;
  loadLocales(ids: Iterable<LocaleId>): Promise<void>;
}

/**
 * `checkpoint` gives a fresh checkpoint per index build, so building it
 * yields to the page in slices (blocking by default).
 */
export function createWordStore(
  load: WordLoader,
  checkpoint: () => Checkpoint = () => blockingCheckpoint(),
): WordStore {
  let index: NameIndex | undefined;
  let indexLoading: Promise<NameIndex> | null = null;
  const locales = new Map<LocaleId, LocaleWords>();
  const loading = new Map<LocaleId, Promise<LocaleWords>>();

  const loadIndex = (): Promise<NameIndex> => {
    if (index !== undefined) return Promise.resolve(index);
    indexLoading ??= load(NAME_INDEX)
      .then((value) => runSliced(nameIndexSteps(value), checkpoint()))
      .then(
        (built) => {
          index = built;
          indexLoading = null;
          return built;
        },
        (error: unknown) => {
          indexLoading = null;
          throw error;
        },
      );
    return indexLoading;
  };

  const loadLocale = (id: LocaleId): Promise<LocaleWords> => {
    const loaded = locales.get(id);
    if (loaded !== undefined) return Promise.resolve(loaded);
    if (localeInfo(id) === undefined) {
      return Promise.reject(new WordListError());
    }
    let pending = loading.get(id);
    if (pending === undefined) {
      pending = load(id).then(
        (value) => {
          const words = parseLocaleWords(value, id);
          locales.set(id, words);
          loading.delete(id);
          return words;
        },
        (error: unknown) => {
          loading.delete(id);
          throw error;
        },
      );
      loading.set(id, pending);
    }
    return pending;
  };

  return {
    index: () => index,
    locale: (id) => locales.get(id),
    loadIndex,
    loadLocales: async (ids) => {
      await Promise.all([...new Set(ids)].map(loadLocale));
    },
  };
}

/** Lists given directly (tests, and code that already holds them). */
export function fixedWordLists(
  index: NameIndex | undefined,
  locales: readonly LocaleWords[],
): WordLists {
  const byId = new Map(locales.map((words) => [words.locale, words]));
  return { index: () => index, locale: (id) => byId.get(id) };
}
