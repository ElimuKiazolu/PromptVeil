import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { allLocales } from '@faker-js/faker';
import { describe, expect, it } from 'vitest';
import { readExtracted } from '@/scripts/opendata/extracted.ts';
import { buildWordLists } from '@/scripts/wordlists.ts';
import {
  parseLocaleWords,
  parseNameIndex,
  WordListError,
  WORDLIST_VERSION,
} from '@/src/core/surrogate/words/format.ts';
import {
  LOCALES,
  localeForRegion,
  NAME_INDEX,
} from '@/src/core/surrogate/words/locales.ts';
import { createWordStore } from '@/src/core/surrogate/words/store.ts';
import { readWordFile } from '../../word-lists.ts';

const DATA = fileURLToPath(
  new URL('../../../../public/data/', import.meta.url),
);

describe('bundled word lists', () => {
  it('are exactly what the installed Faker version and the extracted open data give (npm run generate:wordlists)', () => {
    const packageJson: unknown = JSON.parse(
      readFileSync(
        fileURLToPath(new URL('../../../../package.json', import.meta.url)),
        'utf8',
      ),
    );
    const installed: unknown = JSON.parse(
      readFileSync(
        fileURLToPath(
          new URL(
            '../../../../node_modules/@faker-js/faker/package.json',
            import.meta.url,
          ),
        ),
        'utf8',
      ),
    );
    expect(installed).toMatchObject({ version: '10.6.0' });
    expect(packageJson).toMatchObject({
      devDependencies: { '@faker-js/faker': '10.6.0' },
    });
    const build = buildWordLists(allLocales, readExtracted());
    const names = readdirSync(DATA).filter((name) => name.endsWith('.json'));
    expect(names.sort()).toEqual(build.files.map((file) => file.name).sort());
    for (const file of build.files) {
      expect(readFileSync(`${DATA}${file.name}`, 'utf8')).toBe(file.contents);
    }
  });

  it('build deterministically', () => {
    expect(buildWordLists(allLocales, readExtracted())).toEqual(
      buildWordLists(allLocales, readExtracted()),
    );
  });

  it('stay within NFR4 (5 MB for all locale lists)', () => {
    const total = readdirSync(DATA).reduce(
      (sum, name) => sum + statSync(`${DATA}${name}`).size,
      0,
    );
    expect(total).toBeLessThanOrEqual(5 * 1024 * 1024);
    // Measured at generation: about 0.9 MB.
    expect(total).toBeLessThan(1.5 * 1024 * 1024);
  });

  it('have names for every locale, a name index over all of them, and no duplicates', () => {
    const index = parseNameIndex(readWordFile(NAME_INDEX));
    expect(index.locales).toEqual(LOCALES.map((locale) => locale.id));
    for (const { id } of LOCALES) {
      const words = parseLocaleWords(readWordFile(id), id);
      const given = [
        ...words.given.female,
        ...words.given.male,
        ...words.given.neutral,
      ];
      const family = [
        ...words.family.any,
        ...words.family.female,
        ...words.family.male,
      ];
      expect(given.length).toBeGreaterThan(0);
      expect(family.length).toBeGreaterThan(0);
      for (const list of [
        words.given.female,
        words.given.male,
        words.given.neutral,
        words.family.any,
        words.localities,
        words.postcodes,
      ]) {
        expect(new Set(list).size).toBe(list.length);
      }
      // A name listed for both genders is neutral, never in both lists.
      const male = new Set(words.given.male);
      expect(words.given.female.filter((name) => male.has(name))).toEqual([]);
      // Every name is in the index under this locale.
      const bit = 2 ** index.locales.indexOf(id);
      for (const name of [given[0], family[0]]) {
        const flags = index.names.get((name ?? '').toLowerCase());
        const mask =
          (flags?.female ?? 0) |
          (flags?.male ?? 0) |
          (flags?.neutral ?? 0) |
          (flags?.family ?? 0);
        expect(mask & bit).toBe(bit);
      }
    }
  });

  it('keep the regional differences Faker has (gendered Russian family names, Canadian postcodes)', () => {
    const ru = parseLocaleWords(readWordFile('ru'), 'ru');
    expect(ru.family.female.length).toBeGreaterThan(0);
    expect(ru.family.male.length).toBeGreaterThan(0);
    const ca = parseLocaleWords(readWordFile('en_CA'), 'en_CA');
    // 7,200 listed combinations, merged into one template per letter class.
    expect(ca.postcodes.length).toBeLessThan(20);
    for (const template of ca.postcodes) {
      expect(template).toMatch(
        /^(?:\[[A-Z]+\]|[A-Z])#(?:\[[A-Z]+\]|[A-Z]) #(?:\[[A-Z]+\]|[A-Z])#$/u,
      );
    }
    const de = parseLocaleWords(readWordFile('de'), 'de');
    expect(de.streetTypeOrder).toBe('glued');
    expect(de.streetTypes).toContain('weg');
    const fr = parseLocaleWords(readWordFile('fr'), 'fr');
    expect(fr.streetTypeOrder).toBe('before');
    expect(fr.streetTypes).toContain('Rue');
  });

  it('map regions to locales (pinyin names belong to no region)', () => {
    expect(localeForRegion('GB')?.id).toBe('en_GB');
    expect(localeForRegion('BR')?.id).toBe('pt_BR');
    expect(localeForRegion('AT')?.id).toBe('de');
    expect(localeForRegion('SG')?.id).toBe('en_SG');
    expect(localeForRegion('CN')?.id).toBe('zh_CN');
  });
});

describe('word-list file checks', () => {
  const words = readWordFile('en_GB');

  it('refuse another version, another locale or a malformed field', () => {
    expect(() => parseLocaleWords(words, 'en_US')).toThrow(WordListError);
    expect(() =>
      parseLocaleWords({ ...(words as object), version: 99 }, 'en_GB'),
    ).toThrow(WordListError);
    expect(() =>
      parseLocaleWords({ ...(words as object), legal: [1] }, 'en_GB'),
    ).toThrow(WordListError);
    expect(() =>
      parseLocaleWords(
        { ...(words as object), streetTypeOrder: 'sideways' },
        'en_GB',
      ),
    ).toThrow(WordListError);
    expect(() => parseNameIndex({ version: WORDLIST_VERSION })).toThrow(
      WordListError,
    );
    expect(() =>
      parseNameIndex({
        version: WORDLIST_VERSION,
        locales: ['en_GB'],
        groups: { '1,0,0': 'anna' },
        legal: {},
      }),
    ).toThrow(WordListError);
    expect(() =>
      parseNameIndex({
        version: WORDLIST_VERSION,
        locales: ['en_GB'],
        groups: { '1,0,0,0': ['anna'] },
        legal: {},
      }),
    ).toThrow(WordListError);
    expect(
      parseNameIndex({
        version: WORDLIST_VERSION,
        locales: ['en_GB'],
        groups: { '1,0,0,1': 'anna|robin' },
        legal: { Ltd: 1 },
      }).names.get('robin'),
    ).toEqual({ female: 1, male: 0, neutral: 0, family: 1 });
  });
});

describe('word store', () => {
  it('loads each file once, keeps it, and does not keep a failure', async () => {
    const asked: string[] = [];
    let fail = true;
    const store = createWordStore((name) => {
      asked.push(name);
      if (name === 'de' && fail) return Promise.reject(new Error('gone'));
      return Promise.resolve(readWordFile(name));
    });
    expect(store.index()).toBeUndefined();
    await Promise.all([store.loadIndex(), store.loadIndex()]);
    expect(store.index()?.locales).toHaveLength(LOCALES.length);
    await store.loadLocales(['en_GB', 'en_GB']);
    await store.loadLocales(['en_GB']);
    expect(store.locale('en_GB')?.locale).toBe('en_GB');
    await expect(store.loadLocales(['de'])).rejects.toThrow('gone');
    expect(store.locale('de')).toBeUndefined();
    fail = false;
    await store.loadLocales(['de']);
    expect(store.locale('de')?.locale).toBe('de');
    expect(asked).toEqual([NAME_INDEX, 'en_GB', 'de', 'de']);
  });

  it('builds the name index in slices, giving the page back between them', async () => {
    let calls = 0;
    const store = createWordStore(
      (name) => Promise.resolve(readWordFile(name)),
      () => () => {
        calls += 1;
        return calls % 10 === 0 ? Promise.resolve() : undefined;
      },
    );
    const index = await store.loadIndex();
    // About 21,000 names, 500 per step.
    expect(index.names.size).toBeGreaterThan(20_000);
    expect(calls).toBeGreaterThan(index.names.size / 500 - 2);
    expect(index.names.get('harriet')?.female).toBeGreaterThan(0);
  });

  it('refuses unknown locales and malformed files', async () => {
    const store = createWordStore(() => Promise.resolve({ version: 1 }));
    await expect(store.loadLocales(['xx_XX'])).rejects.toBeInstanceOf(
      WordListError,
    );
    await expect(store.loadLocales(['de'])).rejects.toBeInstanceOf(
      WordListError,
    );
    await expect(store.loadIndex()).rejects.toBeInstanceOf(WordListError);
    // A failed index load is retried.
    const later = createWordStore((name) =>
      Promise.resolve(readWordFile(name)),
    );
    await later.loadIndex();
    expect(later.index()).toBeDefined();
  });
});
