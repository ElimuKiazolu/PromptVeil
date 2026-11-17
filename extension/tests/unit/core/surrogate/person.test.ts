import { describe, expect, it } from 'vitest';
import {
  nameParts,
  parseName,
  rolesOf,
  titleGender,
} from '@/src/core/names/parts.ts';
import { titlePrefixLength } from '@/src/core/names/titles.ts';
import { generateStandIn, NO_WORDS } from '@/src/core/surrogate/engine.ts';
import {
  isWellFormedPersonStandIn,
  personLocale,
} from '@/src/core/surrogate/person.ts';
import type { StandInRequest } from '@/src/core/surrogate/types.ts';
import { WordListError } from '@/src/core/surrogate/words/format.ts';
import { localeWords, nameIndex, testEnv } from '../../word-lists.ts';

// Names: the fixture identities' (tests/fixtures/identities.json) and
// common textbook examples; none belongs to a known person.
function person(value: string): StandInRequest {
  return {
    type: 'PERSON',
    subtype: null,
    country: null,
    value,
    normalised: value.toLowerCase(),
    dateOffsetDays: 40,
    number: 1,
    now: 0,
  };
}

function seed(n: number): Uint8Array {
  return new Uint8Array(32).map((_, i) => (n * 31 + i * 7) % 256);
}

const env = testEnv({ preferred: ['en_GB'] });

/** Stand-ins over many seeds, all checked. */
function standIns(value: string, count = 40, environment = env): string[] {
  const out: string[] = [];
  for (let n = 0; n < count; n += 1) {
    const standIn = generateStandIn(person(value), seed(n), 0, environment);
    if (standIn !== null) out.push(standIn.value);
  }
  expect(out.length).toBeGreaterThan(count * 0.9);
  return out;
}

const lower = (list: readonly string[]) =>
  new Set(list.map((name) => name.toLowerCase()));

describe('name parts', () => {
  it('splits titles, names, initials and particles', () => {
    expect(titlePrefixLength('Dr. Harriet Pemberton')).toBe(4);
    expect(titlePrefixLength('Mr ')).toBe(0);
    const parsed = parseName('Prof. Dr. Maria del Carmen García-López');
    expect(parsed.titleEnd).toBe(10);
    expect(parsed.pieces.map((piece) => [piece.text, piece.kind])).toEqual([
      ['Maria', 'name'],
      ['del', 'particle'],
      ['Carmen', 'name'],
      ['García', 'name'],
      ['López', 'name'],
    ]);
    // Hyphenated pieces share a word.
    expect(parsed.pieces[3]?.word).toBe(parsed.pieces[4]?.word);
    expect(nameParts('J. R. R. Tolkien')).toEqual(['Tolkien']);
    expect(nameParts("Seán O'Brien")).toEqual(['Seán', "O'Brien"]);
    // A lone particle-like word is a name.
    expect(nameParts('Van')).toEqual(['Van']);
  });

  it('reads gender from titles', () => {
    for (const [name, gender] of [
      ['Mrs Harriet Pemberton', 'female'],
      ['Frau Anna Schmidt', 'female'],
      ['Mme Claire Martin', 'female'],
      ['Herr Hans Müller', 'male'],
      ['Shri Arjun Mehta', 'male'],
      ['Dr Harriet Pemberton', null],
    ] as const) {
      expect(titleGender(name, parseName(name))).toBe(gender);
    }
  });

  it('knows which part is the family name', () => {
    const roles = (name: string) => rolesOf(name, parseName(name), nameIndex());
    expect(roles('Harriet Pemberton')).toEqual(['given', 'family']);
    expect(roles('Harriet Anne Pemberton')).toEqual([
      'given',
      'given',
      'family',
    ]);
    expect(roles('Pemberton, Harriet')).toEqual(['family', 'given']);
    expect(roles('DUPONT Jean')).toEqual(['family', 'given']);
    expect(roles('佐藤 太郎')).toEqual(['family', 'given']);
    expect(roles('Hans-Peter Müller')).toEqual(['given', 'given', 'family']);
  });
});

describe('PERSON stand-ins', () => {
  it('are deterministic for a seed and attempt, and attempts differ', () => {
    const a = generateStandIn(person('Harriet Pemberton'), seed(1), 0, env);
    expect(
      generateStandIn(person('Harriet Pemberton'), seed(1), 0, env),
    ).toEqual(a);
    const b = generateStandIn(person('Harriet Pemberton'), seed(1), 1, env);
    expect(b?.value).not.toBe(a?.value);
  });

  it('keep the number of parts, titles, particles, initials and punctuation', () => {
    for (const value of [
      'Harriet Pemberton',
      'Dr. Harriet Anne Pemberton',
      'Mr J. R. Smith',
      'Pemberton, Harriet',
      'Maria del Carmen García',
      'Hans-Peter Müller',
      'DUPONT Jean',
      'Herr Prof. Dr. Klaus Becker',
    ]) {
      for (const standIn of standIns(value, 20)) {
        expect(isWellFormedPersonStandIn(standIn, value)).toBe(true);
        expect(nameParts(standIn)).toHaveLength(nameParts(value).length);
        const real = lower(nameParts(value));
        // Every part replaced.
        for (const part of nameParts(standIn)) {
          expect(real.has(part.toLowerCase())).toBe(false);
        }
      }
    }
    for (const standIn of standIns('Mr J. R. Smith', 20)) {
      expect(standIn).toMatch(/^Mr [A-Z]\. [A-Z]\. \S+$/u);
      expect(standIn).not.toMatch(/^Mr J\. R\./u);
    }
    for (const standIn of standIns('DUPONT Jean', 20)) {
      expect(standIn).toMatch(/^\p{Lu}+ \p{Lu}\p{Ll}/u);
    }
    for (const standIn of standIns('Pemberton, Harriet', 10)) {
      expect(standIn).toMatch(/^\S+, \S+$/u);
    }
    for (const standIn of standIns('Hans-Peter Müller', 10)) {
      expect(standIn).toMatch(/^\S+-\S+ \S+$/u);
    }
  });

  it('take names from the locale the name comes from', () => {
    const cases: [string, string][] = [
      ['Giulia Rossi', 'it'],
      ['Frau Anna Schmidt', 'de'],
      ['Mme Claire Dubois', 'fr'],
      ['Иван Петров', 'ru'],
      ['佐藤 太郎', 'ja'],
      ['김민준', 'ko'],
      ['王伟', 'zh_CN'],
    ];
    for (const [value, locale] of cases) {
      expect(personLocale(value, nameIndex(), ['en_GB'])).toBe(locale);
      const words = localeWords(locale);
      const all = lower([
        ...words.given.female,
        ...words.given.male,
        ...words.given.neutral,
        ...words.family.any,
        ...words.family.female,
        ...words.family.male,
      ]);
      for (const standIn of standIns(value, 15)) {
        const standInParts = nameParts(standIn);
        const known =
          standInParts.length === 1
            ? // A CJK name of one piece: family and given name joined.
              [...all].some((name) => standIn.startsWith(name))
            : standInParts.every((part) => all.has(part.toLowerCase()));
        expect(known).toBe(true);
      }
    }
  });

  it('fall back to the home region, and keep the script', () => {
    // Unknown to every list: the home locale.
    expect(personLocale('Xqzv Wrrtpl', nameIndex(), ['de'])).toBe('de');
    expect(personLocale('Xqzv Wrrtpl', nameIndex(), [])).toBe('en_US');
    // A Latin-letter name never gets Chinese characters, even at home in CN.
    expect(personLocale('Wang Wei', nameIndex(), ['zh_CN'])).not.toBe('zh_CN');
    for (const standIn of standIns(
      'Wang Wei',
      10,
      testEnv({ preferred: ['zh_CN'] }),
    )) {
      expect(standIn).toMatch(/^[\p{Script=Latin}' -]+$/u);
    }
  });

  it('keep the gender a title or the first name shows', () => {
    const en = localeWords('en_GB');
    const female = lower([...en.given.female, ...en.given.neutral]);
    const male = lower([...en.given.male, ...en.given.neutral]);
    for (const standIn of standIns('Mrs Harriet Pemberton', 20)) {
      expect(female.has((nameParts(standIn)[0] ?? '').toLowerCase())).toBe(
        true,
      );
    }
    for (const standIn of standIns('Robert Hale', 20)) {
      expect(male.has((nameParts(standIn)[0] ?? '').toLowerCase())).toBe(true);
    }
    const ru = localeWords('ru');
    const ruFemale = lower(ru.family.female);
    for (const standIn of standIns('Анна Смирнова', 20)) {
      expect(ruFemale.has((nameParts(standIn)[1] ?? '').toLowerCase())).toBe(
        true,
      );
    }
  });

  it('keep CJK lengths', () => {
    for (const standIn of standIns('王伟', 20)) {
      expect(Array.from(standIn)).toHaveLength(2);
    }
    for (const standIn of standIns('김민준', 20)) {
      expect(Array.from(standIn)).toHaveLength(3);
      expect(standIn.startsWith('김')).toBe(false);
    }
  });

  it('report the stand-in parts and its locale', () => {
    const standIn = generateStandIn(
      person('Dr Harriet Pemberton'),
      seed(3),
      0,
      env,
    );
    expect(standIn?.parts).toEqual(nameParts(standIn?.value ?? ''));
    expect(standIn?.parts).toHaveLength(2);
    expect(standIn?.locale).toBe('en_GB');
  });

  it('need their word lists (fail closed)', () => {
    expect(() =>
      generateStandIn(person('Harriet Pemberton'), seed(1), 0, NO_WORDS),
    ).toThrow(WordListError);
  });
});
