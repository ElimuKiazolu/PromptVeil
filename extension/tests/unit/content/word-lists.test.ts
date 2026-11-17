import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  loadWordList,
  WORD_LIST_PATHS,
  WordListLoadError,
} from '@/src/content/word-lists.ts';
import { LOCALES, NAME_INDEX } from '@/src/core/surrogate/words/locales.ts';
import { WORD_DATA } from '../word-lists.ts';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('word-list files in the content script', () => {
  it('name every locale and the index, and each file exists', () => {
    expect(Object.keys(WORD_LIST_PATHS).sort()).toEqual(
      [NAME_INDEX, ...LOCALES.map((locale) => locale.id)].sort(),
    );
    for (const [name, path] of Object.entries(WORD_LIST_PATHS)) {
      expect(path).toBe(`/data/${name}.json`);
      expect(existsSync(join(WORD_DATA, `${name}.json`))).toBe(true);
    }
  });

  it('read a file from the extension package, and reject anything else', async () => {
    const asked: string[] = [];
    vi.stubGlobal('browser', {
      runtime: {
        getURL: (path: string) => `chrome-extension://session-id${path}`,
      },
    });
    vi.stubGlobal('fetch', (url: string) => {
      asked.push(url);
      return Promise.resolve(
        url.endsWith('/de.json')
          ? new Response('{"locale":"de"}', { status: 200 })
          : new Response('', { status: 404 }),
      );
    });
    await expect(loadWordList('de')).resolves.toEqual({ locale: 'de' });
    await expect(loadWordList('fr')).rejects.toBeInstanceOf(WordListLoadError);
    // Only known names: nothing else is ever requested.
    await expect(loadWordList('../secret')).rejects.toBeInstanceOf(
      WordListLoadError,
    );
    await expect(loadWordList('toString')).rejects.toBeInstanceOf(
      WordListLoadError,
    );
    expect(asked).toEqual([
      'chrome-extension://session-id/data/de.json',
      'chrome-extension://session-id/data/fr.json',
    ]);
  });
});
