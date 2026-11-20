import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { creditsText } from '@/scripts/opendata/credits.ts';
import { readExtracted } from '@/scripts/opendata/extracted.ts';
import { readSources } from '@/scripts/opendata/sources.ts';
import { nameParts } from '@/src/core/names/parts.ts';
import { generateStandIn } from '@/src/core/surrogate/engine.ts';
import { personLocale } from '@/src/core/surrogate/person.ts';
import type { StandInRequest } from '@/src/core/surrogate/types.ts';
import { LOCALES } from '@/src/core/surrogate/words/locales.ts';
import type { CountryCode } from '@/src/shared/country.ts';
import type { EntityType } from '@/src/shared/entities.ts';
import { localeWords, nameIndex, testEnv } from '../../word-lists.ts';

// Example names are common names of each country (list data); addresses
// are fictional (made-up street names).

const LICENCES = join(process.cwd(), 'public', 'licenses');

/** Licences allowed in shipped data: no share-alike, no non-commercial. */
const ALLOWED_LICENCES = new Set([
  'Open Government Licence v3.0',
  'Creative Commons Attribution 4.0 International',
  'Singapore Open Data Licence version 1.0',
  'Unicode License V3',
  'CC0 1.0 Universal (public domain dedication)',
]);

function request(
  type: EntityType,
  value: string,
  country: CountryCode | null = null,
): StandInRequest {
  return {
    type,
    subtype: null,
    country,
    value,
    normalised: value.toLowerCase(),
    dateOffsetDays: 40,
    number: 1,
    now: 0,
  };
}

const seed = (n: number): Uint8Array =>
  new Uint8Array(32).map((_, i) => (n * 37 + i * 11) % 256);

const lower = (list: readonly string[]): Set<string> =>
  new Set(list.map((name) => name.toLowerCase()));

/** Every name of a locale, lower case. */
function namesOf(locale: string): Set<string> {
  const words = localeWords(locale);
  return lower([
    ...words.given.female,
    ...words.given.male,
    ...words.given.neutral,
    ...words.family.any,
    ...words.family.female,
    ...words.family.male,
  ]);
}

describe('open-data sources', () => {
  const sources = readSources();

  it('are all retrieved, pinned and under an allowed licence with its text shipped', () => {
    for (const source of sources.sources) {
      expect(ALLOWED_LICENCES, source.id).toContain(source.licence);
      expect(source.licence).not.toMatch(/share.?alike|non.?commercial|ODbL/iu);
      expect(source.attribution).not.toBe('');
      for (const file of source.files) {
        expect(file.retrieved, file.name).toMatch(/^\d{4}-\d{2}-\d{2}$/u);
        expect(file.sha256, file.name).toMatch(/^[0-9a-f]{64}$/u);
        expect(file.bytes, file.name).toBeGreaterThan(0);
      }
    }
    for (const licence of [
      'OGL-3.0.txt',
      'CC-BY-4.0.txt',
      'SODL-1.0.txt',
      'Unicode-3.0.txt',
      'CC0-1.0.txt',
      'Faker-MIT.txt',
    ]) {
      expect(existsSync(join(LICENCES, licence)), licence).toBe(true);
    }
    // GLEIF's legal-form list: CC0 not confirmed for it, so not used.
    expect(sources.skipped.map((skipped) => skipped.id)).toEqual(['gleif-elf']);
  });

  it('give extracted lists that match their recorded checksums and name known sources only', () => {
    const extracted = readExtracted();
    const ids = new Set(sources.sources.map((source) => source.id));
    expect(extracted.map((entry) => entry.locale).sort()).toEqual(
      ['en_GB', 'en_SG', 'ja', 'nl', 'pt_BR', 'sv', 'zh_Latn'].sort(),
    );
    for (const entry of extracted) {
      expect(LOCALES.map((locale) => locale.id)).toContain(entry.locale);
      for (const source of entry.sources) expect(ids).toContain(source);
    }
  });

  it('are credited in the shipped credits file', () => {
    const credits = readFileSync(
      join(LICENCES, 'OPEN-DATA-CREDITS.txt'),
      'utf8',
    );
    expect(credits).toBe(creditsText(sources));
    expect(credits).toContain('Contains OS data © Crown copyright');
    expect(credits).toContain(
      'Source: Office for National Statistics licensed under the Open Government Licence v.3.0',
    );
    expect(credits).toContain('Singapore Open Data Licence version 1.0');
    expect(credits).toContain('GeoNames');
  });
});

describe('stand-ins from the open data', () => {
  const env = testEnv({ preferred: ['en_US'] });

  /** Stand-ins over many seeds, every one checked to exist. */
  function standIns(
    value: string,
    type: EntityType = 'PERSON',
    country: CountryCode | null = null,
    environment = env,
  ): string[] {
    return Array.from({ length: 20 }, (_, n) => {
      const standIn = generateStandIn(
        request(type, value, country),
        seed(n),
        0,
        environment,
      );
      if (standIn === null) throw new Error(`no stand-in for ${value}`);
      return standIn.value;
    });
  }

  it('give British names en_GB stand-ins from the ONS and Wikidata lists', () => {
    expect(personLocale('Callum Forbes', nameIndex(), ['en_US'])).toBe('en_GB');
    const british = namesOf('en_GB');
    for (const standIn of standIns('Callum Forbes')) {
      for (const part of nameParts(standIn)) {
        expect(british).toContain(part.toLowerCase());
      }
    }
    expect(localeWords('en_GB').given.female.length).toBeGreaterThan(400);
  });

  it('use real UK street names and localities in British addresses', () => {
    const words = localeWords('en_GB');
    const streets = new Set(words.streets);
    const places = new Set(words.localities);
    // A made-up street in a made-up locality of a real town.
    for (const standIn of standIns(
      '12 Imaginary Lane, Nowhere Green, Preston',
      'ADDRESS',
      'GB',
    )) {
      const [street, locality, city] = standIn.split(', ');
      const name = street?.split(' ')[1] ?? '';
      expect(streets, standIn).toContain(name);
      expect(places, standIn).toContain(locality);
      expect(city).toBe('Preston');
    }
  });

  it('give Brazilian names pt_BR stand-ins from the larger lists', () => {
    expect(personLocale('João Pereira', nameIndex(), ['en_US'])).toBe('pt_BR');
    expect(localeWords('pt_BR').family.any.length).toBeGreaterThan(400);
    const brazilian = namesOf('pt_BR');
    for (const standIn of standIns('João Pereira')) {
      for (const part of nameParts(standIn)) {
        expect(brazilian).toContain(part.toLowerCase());
      }
    }
  });

  it('recognise romanised Chinese names and give romanised stand-ins', () => {
    const pinyin = namesOf('zh_Latn');
    for (const name of ['Wang Wei', 'Li Na', 'Zhang Xiuying']) {
      expect(personLocale(name, nameIndex(), ['en_US']), name).toBe('zh_Latn');
      for (const standIn of standIns(name)) {
        expect(standIn).toMatch(/^[A-Z][a-z]+ [A-Z][a-z]+$/u);
        for (const part of nameParts(standIn)) {
          expect(pinyin).toContain(part.toLowerCase());
        }
      }
    }
  });

  it('keep romanised Chinese names family name first', () => {
    const family = lower(localeWords('zh_Latn').family.any);
    for (const [name, preferred] of [
      ['Wang Wei', 'en_US'],
      ['Li Na', 'en_US'],
      ['Tan Wei Ming', 'en_SG'],
      // A Singaporean Chinese name: a pinyin stand-in, family name first.
      ['Lim Boon Keng', 'en_SG'],
    ] as const) {
      expect(personLocale(name, nameIndex(), [preferred]), name).toBe(
        'zh_Latn',
      );
      for (const standIn of standIns(
        name,
        'PERSON',
        null,
        testEnv({ preferred: [preferred] }),
      )) {
        const parts = nameParts(standIn);
        expect(parts).toHaveLength(nameParts(name).length);
        expect(family, standIn).toContain(parts[0]?.toLowerCase());
      }
    }
    // Known elsewhere as a given name: given name first.
    expect(personLocale('Lee Morgan', nameIndex(), ['en_US'])).not.toBe(
      'zh_Latn',
    );
  });

  it('give Singaporean names and streets en_SG stand-ins', () => {
    for (const name of ['Siti Fauziah', 'Nur Insyirah']) {
      expect(personLocale(name, nameIndex(), ['en_US']), name).toBe('en_SG');
    }
    const singaporean = namesOf('en_SG');
    for (const standIn of standIns(
      'Siti Fauziah',
      'PERSON',
      null,
      testEnv({ preferred: ['en_SG'] }),
    )) {
      for (const part of nameParts(standIn)) {
        expect(singaporean).toContain(part.toLowerCase());
      }
    }
    const words = localeWords('en_SG');
    const streets = new Set(words.streets);
    for (const standIn of standIns(
      '8 Imaginary Road, Singapore',
      'ADDRESS',
      'SG',
      testEnv({ preferred: ['en_SG'] }),
    )) {
      const name = standIn.split(' ')[1] ?? '';
      expect(streets, standIn).toContain(name);
      expect(standIn).toMatch(/ Road, Singapore$/u);
    }
  });

  it('are deterministic for a seed', () => {
    for (const [value, type] of [
      ['Callum Forbes', 'PERSON'],
      ['Wang Wei', 'PERSON'],
      ['8 Imaginary Road, Singapore', 'ADDRESS'],
    ] as const) {
      expect(standIns(value, type, 'SG')).toEqual(standIns(value, type, 'SG'));
    }
  });
});
