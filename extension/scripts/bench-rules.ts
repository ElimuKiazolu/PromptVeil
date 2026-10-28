/**
 * Rule detector measurements (TR-R2: < 20 ms for 2,000 characters with all
 * P0 rules). Not part of the test run; run on the target laptop:
 *
 *   npm run bench:rules                 timings and false-positive rates
 *   npm run bench:rules -- --equivalence  also the full phone pre-check
 *                                         comparison (slow, ~1 min)
 *
 * Reports:
 * - p50/p95 for typical 2,000-character prompts (warm: after warm-up, as the
 *   draft pre-pass leaves it);
 * - the worst case: several national phone numbers that no home region
 *   accepts, first sight (cold phone cache) and seen before (warm), and the
 *   longest main-thread task while that detection runs time-sliced;
 * - the cost per entity type, and the headroom left for country packs;
 * - false positives of the SECRET thresholds on word-built identifiers and
 *   their recall on random keys.
 *
 * All sample values are documentation or published test values.
 */
import { MessageChannel } from 'node:worker_threads';
import {
  getCountries,
  parsePhoneNumberFromString,
} from 'libphonenumber-js/max';
import examples from 'libphonenumber-js/mobile/examples';
import type { EntityType } from '../src/shared/entities.ts';
import type { CountryCode } from '../src/shared/country.ts';
import { detectRules } from '../src/core/detect/rules/detector.ts';
import { warmUpRules } from '../src/core/detect/rules/analysis.ts';
import {
  COUNTRY_PACKS,
  type CountryPack,
} from '../src/core/detect/rules/packs/index.ts';
import { IN_PACK, isValidPan } from '../src/core/detect/rules/packs/in.ts';
import { createCheckpoint, type Yielder } from '../src/core/detect/schedule.ts';
import {
  clearPhoneCache,
  validatePhone,
} from '../src/core/detect/validators/phone.ts';
import {
  CONTEXT_THRESHOLDS,
  GENERIC_THRESHOLDS,
  isHighEntropyToken,
  type EntropyThresholds,
} from '../src/core/detect/validators/secret.ts';

const P0: ReadonlySet<EntityType> = new Set<EntityType>([
  'EMAIL',
  'PHONE',
  'CARD',
  'BANK',
  'SECRET',
  'NATIONAL_ID',
]);
const HOME: CountryCode[] = ['US'];
const BUDGET_MS = 20;
const LENGTH = 2000;

/** Deterministic pseudo-random numbers (a fixed linear congruential sequence). */
function random(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };
}

const WORDS =
  'the a to of and in for on with as by at from that this we you it is are was be have has will can should please could would our your their report project meeting update draft review customer team plan budget quarter results next week thanks regards issue fix release version build test data model server client request response error log page user payment'.split(
    ' ',
  );

function prose(next: () => number, length: number): string {
  let text = '';
  while (text.length < length) {
    const words = 6 + Math.floor(next() * 12);
    const sentence = Array.from(
      { length: words },
      () => WORDS[Math.floor(next() * WORDS.length)] ?? 'the',
    ).join(' ');
    text += `${sentence.charAt(0).toUpperCase()}${sentence.slice(1)}. `;
  }
  return text.slice(0, length);
}

/** Builds a prompt of exactly LENGTH characters from prose and the given parts. */
function prompt(seed: number, parts: readonly string[]): string {
  const next = random(seed);
  const filler = LENGTH - parts.join(' ').length;
  const gap = Math.max(1, Math.floor(filler / (parts.length + 1)));
  let text = prose(next, gap);
  for (const part of parts) text += ` ${part} ${prose(next, gap)}`;
  return text.slice(0, LENGTH);
}

const fake = (...parts: string[]): string => parts.join('');

const TYPICAL: Record<string, string> = {
  'national IDs': prompt(8, [
    'My SSN is 536-90-4399 and my NI number AB 12 34 56 C.',
    'NHS number 999 000 0018, SIN 123 456 782.',
    'CPF 390.533.447-05, ticket 48213907, invoice 2024001234.',
    'Aadhaar 9999 4105 7058, PAN ACUPA7085R, 身份证 11010519491231002X.',
    'NRIC S1234567D, FIN M1134985K, ID number 7503305044089.',
    'DNI 12345678-Z, codice fiscale RCCMNL83S18D969H, NIR 1 84 12 76 451 089 46, Steuer-ID 36 574 261 809.',
  ]),
  'plain prose': prompt(1, []),
  'mixed entities': prompt(2, [
    'Email dana@example.com or ops@example.org.',
    'Call +1 202 555 0143 or (202) 555-0199.',
    'Card 4242 4242 4242 4242, IBAN GB29 NWBK 6016 1331 9268 19.',
    'Order #12345678 placed 2024-10-19 at 14:30 for $1,249.99, build 10.0.19045.',
  ]),
  'code with keys': prompt(3, [
    `const config = { apiKey: "${fake('AI', 'za', 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r', '_-')}", password: process.env.DB_PASSWORD };`,
    `export GITHUB_TOKEN=${fake('ghp_', 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8')}`,
    'curl -H "Authorization: Basic dXNlcjpwYXNzd29yZA==" https://api.example.com/v1/items?id=42',
    'const id = "550e8400-e29b-41d4-a716-446655440000"; // sha 3f2a9b1c4d5e6f708192a3b4c5d6e7f8091a2b3c',
  ]),
  'pasted (non-ASCII)': prompt(4, [
    'IBAN\u00A0: FR14\u00A02004\u00A01010\u00A00505\u00A00001\u200B3M02\u00A0606',
    'Tél.\u00A0: +33\u00A06\u00A012\u00A034\u00A056\u00A078 — “quoted” ’text’',
    'Ｍａｉｌ ｄａｎａ＠ｅｘａｍｐｌｅ．ｃｏｍ',
  ]),
};

/**
 * libphonenumber's example mobile numbers, written nationally, that are not
 * valid in the home region (so each needs the all-region pass).
 */
const FOREIGN_NATIONAL = [
  'FR',
  'DE',
  'AU',
  'BR',
  'NG',
  'PH',
  'ZA',
  'KE',
  'GB',
  'MX',
]
  .map((region) => {
    const number = (examples as Record<string, string>)[region] ?? '';
    return (
      parsePhoneNumberFromString(number, region as 'FR')?.formatNational() ?? ''
    );
  })
  .filter((number) => {
    if (number === '') return false;
    const result = validatePhone(number, HOME);
    return result.valid && !result.fromHomeRegions;
  });

const WORST: Record<string, string> = {
  '5 foreign national numbers (grouped)': prompt(
    5,
    FOREIGN_NATIONAL.slice(0, 5),
  ),
  '5 foreign national numbers (bare digit runs)': prompt(
    6,
    FOREIGN_NATIONAL.slice(0, 5).map((number) => number.replace(/\D/gu, '')),
  ),
  '10 foreign national numbers (grouped)': prompt(7, FOREIGN_NATIONAL),
};

function percentile(values: readonly number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return (
    sorted[Math.min(sorted.length - 1, Math.floor(p * (sorted.length - 1)))] ??
    0
  );
}

const fmt = (ms: number): string => `${ms.toFixed(1)} ms`;

async function time(
  text: string,
  types: ReadonlySet<EntityType> = P0,
  packs: readonly CountryPack[] = COUNTRY_PACKS,
): Promise<number> {
  const started = performance.now();
  await detectRules(text, {
    homeRegions: HOME,
    entityTypes: types,
    packs,
    exclude: [],
  });
  return performance.now() - started;
}

async function timings(
  text: string,
  runs: number,
  types?: ReadonlySet<EntityType>,
  packs?: readonly CountryPack[],
) {
  const values: number[] = [];
  for (let run = 0; run < runs; run += 1) {
    values.push(await time(text, types, packs));
  }
  return { p50: percentile(values, 0.5), p95: percentile(values, 0.95) };
}

/** Yields like the content script: a new task through a message channel. */
function nodeYielder(): Yielder & { close(): void } {
  const channel = new MessageChannel();
  const waiting: (() => void)[] = [];
  channel.port1.on('message', () => waiting.shift()?.());
  return {
    now: () => performance.now(),
    yieldNow: () =>
      new Promise<void>((resolve) => {
        waiting.push(resolve);
        channel.port2.postMessage(null);
      }),
    close: () => {
      channel.port1.close();
    },
  };
}

/** Longest stretch between yields while detecting `text` time-sliced. */
async function longestTask(
  text: string,
): Promise<{ longest: number; total: number; tasks: number }> {
  const base = nodeYielder();
  let taskStart = performance.now();
  let longest = 0;
  let tasks = 1;
  const yielder: Yielder = {
    now: () => base.now(),
    yieldNow: async () => {
      longest = Math.max(longest, performance.now() - taskStart);
      await base.yieldNow();
      tasks += 1;
      taskStart = performance.now();
    },
  };
  const started = performance.now();
  await detectRules(text, {
    homeRegions: HOME,
    entityTypes: P0,
    packs: COUNTRY_PACKS,
    exclude: [],
    checkpoint: createCheckpoint(yielder),
  });
  longest = Math.max(longest, performance.now() - taskStart);
  base.close();
  return { longest, total: performance.now() - started, tasks };
}

function identifiers(): string[] {
  const next = random(12345);
  const pick = (n: number): number => Math.floor(next() * n);
  const words =
    'a is to of on by in at it be an or as we my no do go up so if me us id ok user profile settings handler request response token account session manager service config build release version update create delete payment invoice order customer product image upload download cache storage queue worker event listener controller module very long camel case identifier this that with from into get set has can'.split(
      ' ',
    );
  const cap = (word: string): string =>
    `${word.charAt(0).toUpperCase()}${word.slice(1)}`;
  const out: string[] = [];
  for (let i = 0; i < 30000; i += 1) {
    const parts = Array.from(
      { length: 3 + (i % 7) },
      () => words[pick(words.length)] ?? 'a',
    ).map((word) => (pick(3) === 0 ? `${word}${pick(100).toString()}` : word));
    const number = pick(2025).toString();
    const [first = 'a', ...rest] = parts;
    out.push(
      parts.map(cap).join('') + number,
      first + rest.map(cap).join(''),
      parts.map(cap).join('_'),
      `${parts.map((word) => word.toUpperCase()).join('_')}${number}`,
      parts.join('_') + number,
      parts.join('-') + number,
    );
  }
  return out.filter((identifier) => identifier.length >= 20);
}

function randomKeys(length: number): string[] {
  const next = random(length * 7919);
  const alphabets = [
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789',
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_',
    'abcdefghijklmnopqrstuvwxyz0123456789',
  ];
  const keys: string[] = [];
  for (let i = 0; i < 3000; i += 1) {
    for (const alphabet of alphabets) {
      keys.push(
        Array.from({ length }, () =>
          alphabet.charAt(Math.floor(next() * alphabet.length)),
        ).join(''),
      );
    }
  }
  return keys;
}

function secretRates(
  name: string,
  thresholds: EntropyThresholds,
  ids: readonly string[],
): void {
  const flagged = ids.filter((id) => isHighEntropyToken(id, thresholds)).length;
  const recall = [20, 24, 32, 40]
    .map((length) => {
      const keys = randomKeys(length);
      const caught = keys.filter((key) =>
        isHighEntropyToken(key, thresholds),
      ).length;
      return `${length.toString()}: ${((100 * caught) / keys.length).toFixed(1)} %`;
    })
    .join(', ');
  console.log(
    `  ${name}: ${((100 * flagged) / ids.length).toFixed(2)} % of ${ids.length.toString()} identifiers flagged; random keys caught ${recall}`,
  );
}

/**
 * PAN has no published checksum, so its shape and holder letter are all
 * that separate it from other upper-case codes.
 */
async function panFalsePositives(ids: readonly string[]): Promise<void> {
  const panOnly = {
    homeRegions: HOME,
    entityTypes: new Set<EntityType>(['NATIONAL_ID']),
    packs: [IN_PACK],
    exclude: [],
  };
  let found = 0;
  for (let i = 0; i < ids.length; i += 500) {
    const detections = await detectRules(
      ids.slice(i, i + 500).join(' '),
      panOnly,
    );
    found += detections.filter((d) => d.subtype === 'IN_PAN').length;
  }
  console.log(
    `  word-built identifiers: ${found.toString()} of ${ids.length.toString()} detected as PAN`,
  );
  const next = random(4242);
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const alphanumeric = `${letters}0123456789`;
  const pick = (alphabet: string): string =>
    alphabet.charAt(Math.floor(next() * alphabet.length));
  const total = 50_000;
  let anyCode = 0;
  let panShaped = 0;
  for (let i = 0; i < total; i += 1) {
    let code = '';
    for (let k = 0; k < 10; k += 1) code += pick(alphanumeric);
    if (isValidPan(code)) anyCode += 1;
    let shaped = '';
    for (let k = 0; k < 5; k += 1) shaped += pick(letters);
    shaped += `${Math.floor(next() * 10_000)
      .toString()
      .padStart(4, '0')}${pick(letters)}`;
    if (isValidPan(shaped)) panShaped += 1;
  }
  console.log(
    `  random 10-character upper-case codes: ${((100 * anyCode) / total).toFixed(2)} % pass; codes already shaped AAAAA9999A: ${((100 * panShaped) / total).toFixed(1)} % pass`,
  );
}

function equivalence(): void {
  const corpus = new Set<string>();
  for (const [region, nationalNumber] of Object.entries(
    examples as Record<string, string>,
  )) {
    const phone = parsePhoneNumberFromString(nationalNumber, region as 'FR');
    if (phone === undefined) continue;
    corpus.add(phone.formatNational());
    corpus.add(phone.formatNational().replace(/\D/gu, ''));
  }
  const next = random(7);
  const prefixes = ['0', '00', '011', '1', '8', '9', '07', '06'];
  for (let i = 0; i < 1200; i += 1) {
    const length = 6 + Math.floor(next() * 10);
    let digits = '';
    for (let k = 0; k < length; k += 1)
      digits += Math.floor(next() * 10).toString();
    corpus.add(digits);
    corpus.add(`${prefixes[i % prefixes.length] ?? ''}${digits.slice(2)}`);
  }
  let mismatches = 0;
  for (const raw of corpus) {
    if (!/^[\d ().\-/]+$/u.test(raw)) continue;
    const expected = new Set<string>();
    for (const region of getCountries()) {
      const phone = parsePhoneNumberFromString(raw, {
        defaultCountry: region,
        extract: false,
      });
      if (phone?.isValid()) expected.add(phone.number);
    }
    const result = validatePhone(raw, []);
    const actual = result.valid ? result.candidates.map((c) => c.e164) : [];
    if ([...expected].sort().join() !== [...actual].sort().join())
      mismatches += 1;
  }
  console.log(
    `  ${corpus.size.toString()} inputs, ${mismatches.toString()} mismatches`,
  );
}

async function main(): Promise<void> {
  console.log(`Foreign national numbers used: ${FOREIGN_NATIONAL.join(' | ')}`);
  console.log(
    `Rule detector, ${LENGTH.toString()}-character prompts, home region ${HOME.join(', ')}\n`,
  );

  // First call of the page: nothing compiled or cached yet.
  clearPhoneCache();
  const [firstName = '', firstText = ''] = Object.entries(WORST)[0] ?? [];
  console.log(
    `First call before warm-up (${firstName}): ${fmt(await time(firstText))}`,
  );

  const warmStart = performance.now();
  const warmYielder = nodeYielder();
  await warmUpRules(createCheckpoint(warmYielder));
  warmYielder.close();
  console.log(`Warm-up (time-sliced): ${fmt(performance.now() - warmStart)}\n`);

  console.log('Typical prompts (warm, 200 runs):');
  for (const [name, text] of Object.entries(TYPICAL)) {
    const { p50, p95 } = await timings(text, 200);
    console.log(
      `  ${name.padEnd(22)} p50 ${fmt(p50)}  p95 ${fmt(p95)}  ${p95 < BUDGET_MS ? 'within' : 'OVER'} ${BUDGET_MS.toString()} ms`,
    );
  }

  console.log('\nCost per entity type (mixed entities prompt, p50 of 200):');
  const mixed = TYPICAL['mixed entities'] ?? '';
  let total = 0;
  for (const type of P0) {
    const { p50 } = await timings(mixed, 200, new Set([type]));
    total += p50;
    console.log(`  ${type.padEnd(8)} ${fmt(p50)}`);
  }
  const { p95: allP95 } = await timings(mixed, 200);
  console.log(
    `  sum ${fmt(total)}; all rules and packs together p95 ${fmt(allP95)}`,
  );

  console.log('\nCost per country pack (national IDs only, 200 runs each):');
  const none = new Set<EntityType>(['NATIONAL_ID']);
  for (const [name, text] of [
    ['national IDs', TYPICAL['national IDs'] ?? ''],
    ['mixed entities', mixed],
    ['plain prose', TYPICAL['plain prose'] ?? ''],
  ] as const) {
    const base = await timings(text, 200, none, []);
    const costs = [];
    for (const pack of COUNTRY_PACKS) {
      const { p50, p95 } = await timings(text, 200, none, [pack]);
      costs.push(
        `${pack.country} p50 ${fmt(Math.max(0, p50 - base.p50))} p95 ${fmt(Math.max(0, p95 - base.p95))}`,
      );
    }
    console.log(`  ${name.padEnd(16)} ${costs.join(' | ')}`);
  }
  console.log(
    `  headroom at p95 with every rule and these ${COUNTRY_PACKS.length.toString()} packs: ${fmt(BUDGET_MS - allP95)} of the ${BUDGET_MS.toString()} ms budget`,
  );

  console.log('\nWorst case: national numbers no home region accepts');
  for (const [name, text] of Object.entries(WORST)) {
    clearPhoneCache();
    const cold = await time(text);
    const { p50, p95 } = await timings(text, 50);
    clearPhoneCache();
    const sliced = await longestTask(text);
    console.log(`  ${name}`);
    console.log(`    first sight (cold cache, blocking): ${fmt(cold)}`);
    console.log(
      `    seen before (warm cache): p50 ${fmt(p50)}  p95 ${fmt(p95)}`,
    );
    console.log(
      `    first sight, time-sliced: ${fmt(sliced.total)} in ${sliced.tasks.toString()} tasks, longest task ${fmt(sliced.longest)}`,
    );
  }

  console.log('\nIN_PAN without a context word (no checksum):');
  await panFalsePositives(identifiers());

  console.log('\nSECRET generic rule thresholds:');
  const ids = identifiers();
  secretRates('generic (no context)', GENERIC_THRESHOLDS, ids);
  secretRates('near a context word', CONTEXT_THRESHOLDS, ids);

  if (process.argv.includes('--equivalence')) {
    console.log('\nPhone pre-check against the full all-region scan:');
    equivalence();
  }
}

await main();
