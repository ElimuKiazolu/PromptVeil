/**
 * The send pipeline over every masked type, with the real detector and the
 * stand-in engine, against an in-memory vault.
 *
 * Values: published examples (libphonenumber, HMRC tutorial NINO,
 * python-stdnum CPF, Braintree test card, SWIFT registry IBAN), a fixture
 * identity address and a made-up AWS-shaped key.
 */
import { sha256 } from '@noble/hashes/sha2.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import { describe, expect, it } from 'vitest';
import { SECRET_TOKENS } from './detect/rules/secret-tokens.ts';
import { calendarDay, isoDate } from '@/src/core/dates/calendar.ts';
import { findDateSpans, readDate } from '@/src/core/dates/writing.ts';
import { normaliseReal } from '@/src/core/detect/normal-form.ts';
import { detectRules } from '@/src/core/detect/rules/detector.ts';
import { COUNTRY_PACKS } from '@/src/core/detect/rules/packs/index.ts';
import {
  createPipeline,
  MASKABLE_TYPES,
  issueStandIns,
  needsMasking,
  StaleStandInsError,
  type CommittedValue,
  type IssueVault,
  type PipelineOptions,
  type PipelineReport,
} from '@/src/core/pipeline.ts';
import { testEngine } from '../word-lists.ts';
import {
  gansuIdAlsoLuhn,
  southAfricanIdAlsoVisa,
  visa13WithoutId,
} from './next-reading.helpers.ts';
import type { CountryCode } from '@/src/shared/country.ts';
import type { Detection, EntityType } from '@/src/shared/entities.ts';

/** The stand-ins issued, as text. */
const issueValues = async (
  ...args: Parameters<typeof issueStandIns>
): Promise<string[]> =>
  (await issueStandIns(...args)).map((standIn) => standIn.value);

/** One seed per value; stand-ins stored on commit. */
function memoryVault() {
  const stored = new Map<
    string,
    { standIn: string; variants: readonly string[] }
  >();
  const used = new Set<string>();
  const vault: IssueVault = {
    prepare: (items) => {
      let fresh = 0;
      return Promise.resolve({
        dateOffsetDays: -45,
        values: items.map((entry) => {
          const existing = stored.get(entry.normalised);
          if (existing !== undefined) {
            return { kind: 'existing' as const, ...existing };
          }
          fresh += 1;
          return {
            kind: 'new' as const,
            seed: sha256(utf8ToBytes(entry.normalised)),
            number: stored.size + fresh,
          };
        }),
      });
    },
    commit: (entries) =>
      Promise.resolve({
        values: entries.map((entry): CommittedValue => {
          if (used.has(entry.standIn)) return { kind: 'taken' };
          used.add(entry.standIn);
          stored.set(entry.item.normalised, {
            standIn: entry.standIn,
            variants: entry.variants,
          });
          return { kind: 'inserted', standIn: entry.standIn };
        }),
        missing: 0,
      }),
  };
  return { vault, used };
}

const detectAll = (text: string) =>
  detectRules(text, {
    homeRegions: ['GB'],
    entityTypes: MASKABLE_TYPES,
    packs: COUNTRY_PACKS,
    exclude: [],
  });

function pipeline(options: Partial<PipelineOptions> = {}) {
  const { vault, used } = memoryVault();
  const reports: PipelineReport[] = [];
  const created = createPipeline({
    detect: detectAll,
    normalise: (d) => normaliseReal(d.type, d.subtype, d.country, d.value),
    engine: () => Promise.resolve(testEngine()),
    mask: (_items, issue) => issue(vault),
    isIssued: (value) => used.has(value),
    entityTypes: () => MASKABLE_TYPES,
    report: (report) => reports.push(report),
    ...options,
  });
  return { ...created, reports, used };
}

const REAL = [
  '07400 123456',
  'AB 12 34 56 C',
  '390.533.447-05',
  '4111 1111 1111 1111',
  'GB82 WEST 1234 5698 7654 32',
  // Built at run time: no scanner-matching literal in the repository.
  SECRET_TOKENS.AWS_ACCESS_KEY ?? '',
  'dana.whitfield@example.com',
] as const;
const PROMPT = `Call me on ${REAL[0]}. NI number ${REAL[1]}, CPF ${REAL[2]}, card ${REAL[3]}, IBAN ${REAL[4]}, key ${REAL[5]}, mail ${REAL[6]}.`;
const compact = (value: string) => value.replace(/[^a-z0-9]/giu, '');

describe('pipeline over every masked type', () => {
  it('replaces every confirmed value, leaving no real value in any writing', async () => {
    const { transform, reports, used } = pipeline();
    const masked = await transform(PROMPT);
    for (const value of REAL) {
      expect(compact(masked)).not.toContain(compact(value));
    }
    expect(reports[0]?.masked).toBe(REAL.length);
    // Nothing in the result needs masking again.
    const left = (await detectAll(masked)).filter((d) =>
      needsMasking(d, MASKABLE_TYPES, (value) => used.has(value)),
    );
    expect(left).toEqual([]);
  });

  it('gives a value the same stand-in each time, keeping the text around it', async () => {
    const { transform } = pipeline();
    const first = await transform(`a ${REAL[1]} b ${REAL[1]} c`);
    const [one, two] = first.match(/TN \d\d \d\d \d\d [A-D]/gu) ?? [];
    expect(one).toBeDefined();
    expect(first).toBe(`a ${one ?? ''} b ${two ?? ''} c`);
    expect(one).toBe(two);
    expect(await transform(`again ${REAL[1]}`)).toBe(`again ${one ?? ''}`);
  });

  it('leaves possible detections as they are and counts them', async () => {
    const { transform, reports } = pipeline();
    // libphonenumber's example Indian mobile as a bare run: possible (home GB).
    const masked = await transform(
      'Colleague 8123456789 and mail dana.whitfield@example.com',
    );
    expect(masked).toContain('8123456789');
    expect(masked).not.toContain('dana.whitfield');
    expect(reports[0]).toMatchObject({ masked: 1, possible: 1 });
  });

  it('masks only the types switched on in settings', async () => {
    const { transform } = pipeline({
      entityTypes: () => new Set<EntityType>(['EMAIL', 'PHONE']),
    });
    const masked = await transform(PROMPT);
    expect(masked).toContain(REAL[3]);
    expect(masked).not.toContain(REAL[0]);
  });

  it('yields between values and reports each phase', async () => {
    let checks = 0;
    let tick = 0;
    const { transform, reports } = pipeline({
      checkpoint: () => () => {
        checks += 1;
        return Promise.resolve();
      },
      clock: () => (tick += 1),
    });
    await transform(PROMPT);
    expect(checks).toBe(REAL.length);
    const timings = reports[0]?.timings;
    expect(timings?.rules).toBeGreaterThan(0);
    expect(timings?.prepare).toBeGreaterThan(0);
    expect(timings?.generate).toBeGreaterThan(0);
    expect(timings?.commit).toBeGreaterThan(0);
    expect(timings?.total).toBeGreaterThan(timings?.commit ?? 0);
  });

  it('reports a prompt with nothing to mask too', async () => {
    const { transform, reports } = pipeline();
    expect(await transform('nothing here')).toBe('nothing here');
    expect(reports[0]).toMatchObject({ masked: 0, possible: 0 });
  });
});

describe('needsMasking', () => {
  const found = (overrides: Partial<Detection>): Detection => ({
    type: 'EMAIL',
    subtype: null,
    country: null,
    start: 0,
    end: 10,
    value: 'dana@example.com',
    confidence: 1,
    validated: true,
    source: 'rule',
    status: 'confirmed',
    alternatives: [],
    ...overrides,
  });
  const types = new Set<EntityType>(['EMAIL', 'PHONE']);

  it('is true only for confirmed values of masked types that are not stand-ins', () => {
    expect(needsMasking(found({}), types, () => false)).toBe(true);
    expect(
      needsMasking(found({ status: 'possible' }), types, () => false),
    ).toBe(false);
    expect(needsMasking(found({ type: 'CARD' }), types, () => false)).toBe(
      false,
    );
    expect(needsMasking(found({}), types, () => true)).toBe(false);
    expect(
      needsMasking(
        found({ value: 'standin.3.ab12@example.net' }),
        types,
        () => false,
      ),
    ).toBe(false);
  });
});

describe('one commit per send', () => {
  const item = {
    type: 'EMAIL' as const,
    subtype: null,
    country: null,
    value: 'dana.whitfield@example.com',
    normalised: 'dana.whitfield@example.com',
  };
  const existing: IssueVault['prepare'] = () =>
    Promise.resolve({
      dateOffsetDays: 30,
      values: [
        {
          kind: 'existing',
          standIn: 'standin.1.ab12@example.net',
          variants: [],
        },
      ],
    });

  it('commits stored values as reused, even with nothing new', async () => {
    const commits: unknown[] = [];
    const vault: IssueVault = {
      prepare: existing,
      commit: (entries, reused) => {
        commits.push({ entries: entries.length, reused: reused.length });
        return Promise.resolve({ values: [], missing: 0 });
      },
    };
    const standIns = await issueValues([item], vault, {
      standIn: testEngine().standIn,
      fits: () => true,
      now: 0,
    });
    expect(standIns).toEqual(['standin.1.ab12@example.net']);
    expect(commits).toEqual([{ entries: 0, reused: 1 }]);
  });

  it('rejects with StaleStandInsError when a reused value is gone', async () => {
    const vault: IssueVault = {
      prepare: existing,
      commit: () => Promise.resolve({ values: [], missing: 1 }),
    };
    await expect(
      issueValues([item], vault, {
        standIn: testEngine().standIn,
        fits: () => true,
        now: 0,
      }),
    ).rejects.toBeInstanceOf(StaleStandInsError);
  });

  it('prepare() looks up the values a Send would mask, and nothing else', async () => {
    const peeked: string[][] = [];
    const { prepare } = pipeline({
      peek: (items) => {
        peeked.push(items.map((entry) => entry.type));
        return Promise.resolve();
      },
    });
    await prepare(PROMPT);
    expect(peeked).toHaveLength(1);
    expect(peeked[0]).toHaveLength(REAL.length);
    await prepare('nothing to mask here');
    expect(peeked).toHaveLength(1);
  });
});

describe('dates of birth in the pipeline', () => {
  const today = calendarDay(Date.now());
  const datesIn = (text: string): string[] =>
    findDateSpans(text).map((span) => text.slice(span.start, span.end));

  it('gives every writing of one date the same stand-in date, written its way', async () => {
    const { transform, reports } = pipeline();
    const prompt =
      'DOB 12/03/1990. She was born on 12 March 1990 (birthday: 1990-03-12).';
    const first = await transform(prompt);
    const written = datesIn(first);
    expect(written).toHaveLength(3);
    expect(written[0]).toMatch(/^\d{2}\/\d{2}\/19(?:89|90|91)$/u);
    expect(written[1]).toMatch(/^\d{1,2} [A-Z][a-z]+ 19(?:89|90|91)$/u);
    expect(written[2]).toMatch(/^19(?:89|90|91)-\d{2}-\d{2}$/u);
    const dates = new Set(
      written.map((text) => {
        const reading = readDate(text, 'GB', today);
        return reading === null ? '' : isoDate(reading.date);
      }),
    );
    expect(dates.size).toBe(1);
    expect(dates.has('1990-03-12')).toBe(false);
    expect(reports[0]?.masked).toBe(1);
    // Sent again (stored now, in another writing first): the same text.
    expect(await transform(prompt)).toBe(first);
    expect(await transform('born on 12 March 1990 (DOB 12/03/1990)')).toBe(
      `born on ${written[1] ?? ''} (DOB ${written[0] ?? ''})`,
    );
  });

  it('counts dates whose day and month could go either way', async () => {
    const { transform, reports } = pipeline();
    await transform('DOB 03/04/1990');
    await transform('DOB 25/04/1991');
    expect(reports.map((report) => report.ambiguousDates)).toEqual([1, 0]);
  });
});

describe('card stand-ins in the pipeline', () => {
  /** A Luhn-valid Maestro number made from a label (in memory only). */
  function maestro(label: string): string {
    const bytes = sha256(utf8ToBytes(label));
    let body = '6759';
    for (let i = 0; body.length < 15; i += 1) {
      body += ((bytes[i] ?? 0) % 10).toString();
    }
    for (let check = 0; check < 10; check += 1) {
      const number = body + check.toString();
      let sum = 0;
      for (const [i, char] of Array.from(number).reverse().entries()) {
        let digit = Number(char);
        if (i % 2 === 1) digit = digit * 2 > 9 ? digit * 2 - 9 : digit * 2;
        sum += digit;
      }
      if (sum % 10 === 0) return number;
    }
    throw new Error('no check digit');
  }

  it('borrows a related brand number once the brand is used up, and counts it', async () => {
    const { transform, reports } = pipeline();
    const cards = ['a', 'b', 'c'].map((label) => maestro(`maestro ${label}`));
    const masked = await transform(
      `cards ${cards[0] ?? ''}, ${cards[1] ?? ''} and ${cards[2] ?? ''}`,
    );
    for (const card of cards) expect(masked).not.toContain(card);
    // Two Maestro test numbers are published: the third value borrows.
    expect(reports[0]?.cardFallbacks).toBe(1);
  });
});

describe('next reading instead of blocking', () => {
  const detectWith = (homeRegions: readonly CountryCode[]) => (text: string) =>
    detectRules(text, {
      homeRegions,
      entityTypes: MASKABLE_TYPES,
      packs: COUNTRY_PACKS,
      exclude: [],
    });

  for (const home of ['US', 'GB'] as const) {
    it(`masks an 18-digit Gansu ID that also passes Luhn as an ID (home ${home})`, async () => {
      const id = gansuIdAlsoLuhn();
      const detect = detectWith([home]);
      // Read as a UnionPay card first: no 18-digit test number exists.
      const [found] = await detect(`My number is ${id}.`);
      expect(found?.type).toBe('CARD');
      expect(found?.alternatives.map((a) => a.subtype)).toContain('CN_RIC');
      const { transform, reports } = pipeline({ detect });
      const masked = await transform(`My number is ${id}.`);
      const standIn = /\d{17}[\dX]/u.exec(masked)?.[0] ?? '';
      expect(standIn).not.toBe(id);
      expect(standIn.slice(0, 2)).toBe('62');
      expect(reports[0]?.nextReadings).toBe(1);
      // The stand-in is a well-formed Chinese ID, not a card.
      const again = await detect(`ID ${standIn}`);
      expect(again.map((d) => d.subtype)).toContain('CN_RIC');
    });
  }

  it('masks a South African ID that reads as a 13-digit Visa number as an ID', async () => {
    const id = southAfricanIdAlsoVisa();
    const { transform, reports } = pipeline();
    const masked = await transform(`My number is ${id}.`);
    expect(masked).not.toContain(id);
    const standIn = /\d{13}/u.exec(masked)?.[0] ?? '';
    expect(standIn).not.toBe('');
    expect(reports[0]?.nextReadings).toBe(1);
    // Read as a card again first (it still passes Luhn), with its ID reading.
    const again = await detectAll(`ID ${standIn}`);
    expect(
      again.flatMap((d) => [
        d.subtype,
        ...d.alternatives.map((a) => a.subtype),
      ]),
    ).toContain('ZA_ID');
  });

  it('still blocks a 13-digit card with no ID reading, with the card error', async () => {
    const { transform, reports } = pipeline();
    await expect(
      transform(`My number is ${visa13WithoutId()}.`),
    ).rejects.toMatchObject({ name: 'TestCardsExhaustedError' });
    expect(reports).toEqual([]);
  });
});
