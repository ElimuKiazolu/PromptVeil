/**
 * Stand-in generators over many seeds: format and checksum, layout,
 * determinism, spread, reserved ranges first, embedded facts.
 *
 * Real values are published examples only: libphonenumber's example
 * numbers, Stripe test cards, SWIFT IBAN registry examples, python-stdnum
 * and issuer documentation examples (as in the pack tests); secret tokens
 * are built at run time. Seeds are derived from a counter (no real seed).
 */
import { sha256 } from '@noble/hashes/sha2.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';
import { mod11_2CheckCharacter } from '@/src/core/detect/checksum.ts';
import { normaliseReal } from '@/src/core/detect/normal-form.ts';
import { detectRules } from '@/src/core/detect/rules/detector.ts';
import { COUNTRY_PACKS } from '@/src/core/detect/rules/packs/index.ts';
import { cfCheckLetter } from '@/src/core/detect/rules/packs/it.ts';
import {
  generateStandIn,
  isWellFormedStandIn,
  RESERVED_ATTEMPTS,
  StandInError,
} from '@/src/core/surrogate/engine.ts';
import { alphanumerics } from '@/src/core/surrogate/layout.ts';
import { isReservedPhone } from '@/src/core/surrogate/phone.ts';
import { AWS_EXAMPLE_ACCESS_KEY_ID } from '@/src/core/surrogate/secret.ts';
import { TEST_CARDS } from '@/src/core/surrogate/card.ts';
import type { StandInRequest } from '@/src/core/surrogate/types.ts';
import type { CountryCode } from '@/src/shared/country.ts';
import type { EntitySubtype, EntityType } from '@/src/shared/entities.ts';
import { SECRET_TOKENS } from '../detect/rules/secret-tokens.ts';

/** Base64 (url-safe without padding when asked) of UTF-8 text. */
const base64 = (text: string, url = false): string => {
  const encoded = Buffer.from(text, 'utf8').toString(
    url ? 'base64url' : 'base64',
  );
  return encoded;
};

/**
 * Encoded secrets built at run time from made-up parts (no literal token in
 * the repository): a JWT, HTTP Basic credentials and a PEM block.
 */
const ENCODED_SECRETS = [
  [
    base64('{"alg":"HS256","typ":"JWT"}', true),
    base64('{"sub":"user-1234","name":"Test User"}', true),
    'c2lnbmF0dXJlLWZvci10ZXN0cy1vbmx5LW5vdC1yZWFs',
  ].join('.'),
  base64('demo.user:not-a-real-password-42'),
  [
    '-----BEGIN ',
    'PRIVATE KEY-----\n',
    'MIIBVQIBADANBgkqhkiG9w0BAQEFAASCAT8wggE7AgEAAkEA\n',
    'q7BFUpkGp3+XQ2xV9h0n\n',
    '-----END ',
    'PRIVATE KEY-----',
  ].join(''),
];

const SEEDS = 200;
const seed = (n: number): Uint8Array =>
  sha256(utf8ToBytes(`stand-in test seed ${n.toString()}`));
/** 2026-11-11, fixed so date shifts are reproducible. */
const NOW = Date.UTC(2026, 10, 11);
const OFFSET = -120;

function request(
  type: EntityType,
  subtype: EntitySubtype | null,
  country: CountryCode | null,
  value: string,
): StandInRequest {
  return {
    type,
    subtype,
    country,
    value,
    normalised: normaliseReal(type, subtype, country, value),
    dateOffsetDays: OFFSET,
    number: 3,
    now: NOW,
  };
}

/** Every letter and digit as "#": the written form. */
const shape = (value: string): string => value.replace(/[A-Za-z0-9]/gu, '#');

interface Case {
  type: EntityType;
  subtype: EntitySubtype | null;
  country: CountryCode | null;
  values: string[];
  /** Whether attempt 0 comes from a reserved range. */
  reserved: boolean;
  /** False for encoded secrets, whose characters change kind. */
  layout?: boolean;
}

const CASES: Record<string, Case> = {
  'PHONE GB mobile': {
    type: 'PHONE',
    subtype: null,
    country: 'GB',
    // libphonenumber's example UK mobile number in several written forms.
    values: [
      '07400 123456',
      '+44 7400 123456',
      '+44 (0)7400 123456',
      '0044 7400 123456',
      '07400123456',
    ],
    reserved: true,
  },
  'PHONE GB fixed': {
    type: 'PHONE',
    subtype: null,
    country: 'GB',
    values: ['0121 234 5678', '+44 121 234 5678'],
    reserved: true,
  },
  'PHONE CA': {
    type: 'PHONE',
    subtype: null,
    country: 'CA',
    values: ['(506) 234-5678', '+1 506 234 5678', '506.234.5678'],
    reserved: true,
  },
  'PHONE FR': {
    type: 'PHONE',
    subtype: null,
    country: 'FR',
    values: ['06 12 34 56 78', '+33 6 12 34 56 78', '01 23 45 67 89'],
    reserved: true,
  },
  'PHONE AU fixed': {
    type: 'PHONE',
    subtype: null,
    country: 'AU',
    values: ['02 1234 5678', '+61 2 1234 5678'],
    reserved: true,
  },
  'PHONE AU mobile (no range)': {
    type: 'PHONE',
    subtype: null,
    country: 'AU',
    values: ['0412 345 678'],
    reserved: false,
  },
  'PHONE DE, IN (no range)': {
    type: 'PHONE',
    subtype: null,
    country: 'DE',
    values: ['+49 1512 3456789', '+91 81234 56789'],
    reserved: false,
  },
  CARD: {
    type: 'CARD',
    subtype: null,
    country: null,
    values: [
      '4242 4242 4242 4242',
      '4111-1111-1111-1111',
      '5555555555554444',
      '3782 822463 10005',
      '36227206271667',
      '6205500000000000004',
    ],
    reserved: true,
  },
  IBAN: {
    type: 'BANK',
    subtype: 'IBAN',
    country: null,
    // SWIFT IBAN registry examples, print and electronic forms.
    values: [
      'DE89 3704 0044 0532 0130 00',
      'GB82WEST12345698765432',
      'gb82 west 1234 5698 7654 32',
      'FR1420041010050500013M02606',
    ],
    reserved: false,
  },
  US_SSN: {
    type: 'NATIONAL_ID',
    subtype: 'US_SSN',
    country: 'US',
    values: ['536-90-4399', '536 90 4399', '536904399'],
    reserved: true,
  },
  UK_NINO: {
    type: 'NATIONAL_ID',
    subtype: 'UK_NINO',
    country: 'GB',
    values: ['AB123456C', 'AB 12 34 56 C'],
    reserved: true,
  },
  UK_NHS: {
    type: 'NATIONAL_ID',
    subtype: 'UK_NHS',
    country: 'GB',
    values: ['943 476 5919', '943-476-5919', '9434765919'],
    reserved: true,
  },
  CA_SIN: {
    type: 'NATIONAL_ID',
    subtype: 'CA_SIN',
    country: 'CA',
    values: ['123-456-782', '123 456 782', '123456782'],
    reserved: false,
  },
  BR_CPF: {
    type: 'NATIONAL_ID',
    subtype: 'BR_CPF',
    country: 'BR',
    values: ['390.533.447-05', '39053344705'],
    reserved: false,
  },
  IN_AADHAAR: {
    type: 'NATIONAL_ID',
    subtype: 'IN_AADHAAR',
    country: 'IN',
    values: ['2341 2341 2346', '2341-2341-2346', '234123412346'],
    reserved: false,
  },
  IN_VID: {
    type: 'NATIONAL_ID',
    subtype: 'IN_VID',
    country: 'IN',
    values: ['2341 2341 2341 2341', '2341234123412341'],
    reserved: false,
  },
  IN_PAN: {
    type: 'NATIONAL_ID',
    subtype: 'IN_PAN',
    country: 'IN',
    values: ['ACUPA7085R', 'AAPPV8261K'],
    reserved: false,
  },
  CN_RIC: {
    type: 'NATIONAL_ID',
    subtype: 'CN_RIC',
    country: 'CN',
    values: [
      '11010519491231002X',
      '11010519491231002x',
      '110105 19491231 002X',
      '360426199101010071',
    ],
    reserved: false,
  },
  SG_NRIC: {
    type: 'NATIONAL_ID',
    subtype: 'SG_NRIC',
    country: 'SG',
    values: ['S1234567D', 'T8890856I', 'F8234009L', 'G1166318X', 'M1134985K'],
    reserved: false,
  },
  ZA_ID: {
    type: 'NATIONAL_ID',
    subtype: 'ZA_ID',
    country: 'ZA',
    values: [
      '7503305044089',
      '750330 5044 08 9',
      '750330 5044089',
      '9807055009087',
    ],
    reserved: false,
  },
  ES_DNI: {
    type: 'NATIONAL_ID',
    subtype: 'ES_DNI',
    country: 'ES',
    values: [
      '12345678Z',
      '12345678-Z',
      '12345678 z',
      'X1234567L',
      'X-2482300-W',
      'x2482300w',
    ],
    reserved: false,
  },
  IT_CF: {
    type: 'NATIONAL_ID',
    subtype: 'IT_CF',
    country: 'IT',
    values: ['RCCMNL83S18D969H', 'CNTCHR83T41D969D', 'RSSMRA85T10A562S'],
    reserved: false,
  },
  FR_NIR: {
    type: 'NATIONAL_ID',
    subtype: 'FR_NIR',
    country: 'FR',
    values: [
      '2 95 10 99 126 111 93',
      '295109912611193',
      '253072B07300470',
      '253072A07300443',
      '1 84 12 76 451 089 46',
    ],
    reserved: false,
  },
  DE_TAXID: {
    type: 'NATIONAL_ID',
    subtype: 'DE_TAXID',
    country: 'DE',
    values: ['36 574 261 809', '36574261809', '86095742719'],
    reserved: false,
  },
  SECRET: {
    type: 'SECRET',
    subtype: null,
    country: null,
    values: [
      ...Object.values(SECRET_TOKENS),
      // Made up: a generic high-entropy key, a hexadecimal key, and an
      // assigned password (no vendor format).
      'Zq8fK2mVx9LpR4tW7nB3cY6hJ1dG5sQe',
      'a3f9c1d27b8e4f6051c2d3e4f5a6b7c8',
      'hunter2-Example!',
    ],
    reserved: false,
  },
  'SECRET (encoded)': {
    type: 'SECRET',
    subtype: null,
    country: null,
    values: ENCODED_SECRETS,
    reserved: false,
    layout: false,
  },
};

const ATTEMPTS = [0, 1, RESERVED_ATTEMPTS - 1, RESERVED_ATTEMPTS, 15];

describe.each(Object.entries(CASES))('%s', (_name, testCase) => {
  it.each(testCase.values)(
    'gives well-formed, distinct stand-ins written like %s',
    (value) => {
      const real = request(
        testCase.type,
        testCase.subtype,
        testCase.country,
        value,
      );
      let missing = 0;
      for (let n = 0; n < SEEDS; n += 1) {
        for (const attempt of ATTEMPTS) {
          const standIn = generateStandIn(real, seed(n), attempt);
          if (standIn === null) {
            missing += 1;
            continue;
          }
          expect(isWellFormedStandIn(real, standIn.value), standIn.value).toBe(
            true,
          );
          expect(standIn.value).not.toBe(value);
          expect(standIn.normalised).not.toBe(real.normalised);
          expect(standIn.normalised).toBe(
            normaliseReal(real.type, real.subtype, real.country, standIn.value),
          );
          if (testCase.layout !== false) {
            expect(shape(standIn.value), standIn.value).toBe(shape(value));
          }
        }
      }
      // An attempt may come up empty (the masker moves on); rarely.
      expect(missing).toBeLessThan((SEEDS * ATTEMPTS.length) / 100);
    },
    // 1,000 generations; coverage instrumentation makes them several
    // times slower.
    30_000,
  );

  it('is deterministic for a seed and attempt', () => {
    const [value = ''] = testCase.values;
    const real = request(
      testCase.type,
      testCase.subtype,
      testCase.country,
      value,
    );
    for (let n = 0; n < 20; n += 1) {
      for (const attempt of ATTEMPTS) {
        expect(generateStandIn(real, seed(n), attempt)).toEqual(
          generateStandIn(real, seed(n), attempt),
        );
      }
    }
  });

  it('spreads random stand-ins across seeds', () => {
    const [value = ''] = testCase.values;
    const real = request(
      testCase.type,
      testCase.subtype,
      testCase.country,
      value,
    );
    const seen = new Set<string>();
    for (let n = 0; n < SEEDS; n += 1) {
      const standIn = generateStandIn(real, seed(n), RESERVED_ATTEMPTS);
      if (standIn !== null) seen.add(standIn.value);
    }
    expect(seen.size).toBeGreaterThan(SEEDS * 0.95);
  });

  it(`uses a reserved range first: ${testCase.reserved ? 'yes' : 'none exists'}`, () => {
    const [value = ''] = testCase.values;
    const real = request(
      testCase.type,
      testCase.subtype,
      testCase.country,
      value,
    );
    for (let n = 0; n < 50; n += 1) {
      expect(generateStandIn(real, seed(n), 0)?.reserved).toBe(
        testCase.reserved,
      );
      expect(generateStandIn(real, seed(n), RESERVED_ATTEMPTS)?.reserved).toBe(
        false,
      );
    }
  });
});

describe('random national ID stand-ins pass the full validator', () => {
  const specs = new Map(
    COUNTRY_PACKS.flatMap((pack) => Object.entries(pack.standIns)),
  );
  it.each(
    Object.values(CASES).filter((testCase) => testCase.type === 'NATIONAL_ID'),
  )('$subtype', (testCase) => {
    const spec = specs.get(testCase.subtype ?? '');
    if (spec === undefined) throw new Error('no spec');
    for (const value of testCase.values) {
      const real = request(
        testCase.type,
        testCase.subtype,
        testCase.country,
        value,
      );
      for (let n = 0; n < SEEDS; n += 1) {
        const standIn = generateStandIn(real, seed(n), RESERVED_ATTEMPTS);
        if (standIn !== null)
          expect(spec.isValid(standIn.value), standIn.value).toBe(true);
      }
    }
  });
});

describe('reserved ranges', () => {
  const detected = async (text: string, home: CountryCode) =>
    (
      await detectRules(text, {
        homeRegions: [home],
        entityTypes: new Set<EntityType>([
          'PHONE',
          'NATIONAL_ID',
          'CARD',
          'SECRET',
        ]),
        packs: COUNTRY_PACKS,
        exclude: [],
      })
    ).map((detection) => `${detection.type}/${detection.subtype ?? '-'}`);

  it('phone stand-ins from fiction ranges are never detected again', async () => {
    const cases: [CountryCode, string][] = [
      ['GB', '07400 123456'],
      ['GB', '0121 234 5678'],
      ['CA', '(506) 234-5678'],
      ['FR', '06 12 34 56 78'],
      ['FR', '01 23 45 67 89'],
      ['AU', '02 1234 5678'],
    ];
    for (const [country, value] of cases) {
      const real = request('PHONE', null, country, value);
      for (let n = 0; n < 20; n += 1) {
        const standIn = generateStandIn(real, seed(n), 0);
        if (standIn === null) throw new Error('no stand-in');
        expect(isReservedPhone(standIn.value, country), standIn.value).toBe(
          true,
        );
        expect(await detected(`Call me on ${standIn.value}.`, country)).toEqual(
          [],
        );
      }
      // A random stand-in looks real: it is detected (and excluded as an
      // issued stand-in by the masker).
      const random = generateStandIn(real, seed(1), RESERVED_ATTEMPTS);
      if (random === null) throw new Error('no stand-in');
      expect(await detected(`Call me on ${random.value}.`, country)).toEqual([
        'PHONE/-',
      ]);
    }
  });

  it('keeps the area of a geographic number when its area has a range', () => {
    const london = generateStandIn(
      request('PHONE', null, 'GB', '0121 234 5678'),
      seed(1),
      0,
    );
    expect(london?.value).toMatch(/^0121 496 0\d{3}$/u);
    const paris = generateStandIn(
      request('PHONE', null, 'FR', '01 23 45 67 89'),
      seed(1),
      0,
    );
    expect(paris?.value).toMatch(/^01 99 00 \d\d \d\d$/u);
    const mobile = generateStandIn(
      request('PHONE', null, 'GB', '+44 (0)7400 123456'),
      seed(1),
      0,
    );
    expect(mobile?.value).toMatch(/^\+44 \(0\)7700 900\d{3}$/u);
    const nanp = generateStandIn(
      request('PHONE', null, 'CA', '(506) 234-5678'),
      seed(1),
      0,
    );
    expect(nanp?.value).toMatch(/^\(506\) 555-01\d\d$/u);
  });

  it('SSN 666 and NINO TN stand-ins are rejected by the detector', async () => {
    for (let n = 0; n < 20; n += 1) {
      const ssn = generateStandIn(
        request('NATIONAL_ID', 'US_SSN', 'US', '536-90-4399'),
        seed(n),
        0,
      );
      expect(ssn?.value).toMatch(/^666-\d\d-\d{4}$/u);
      expect(await detected(`SSN ${ssn?.value ?? ''}`, 'US')).toEqual([]);
      const nino = generateStandIn(
        request('NATIONAL_ID', 'UK_NINO', 'GB', 'AB 12 34 56 C'),
        seed(n),
        0,
      );
      expect(nino?.value).toMatch(/^TN \d\d \d\d \d\d [A-D]$/u);
      expect(await detected(`NI number ${nino?.value ?? ''}`, 'GB')).toEqual(
        [],
      );
    }
  });

  it('NHS 999, Stripe test cards and the AWS example key are detected (documented)', async () => {
    const nhs = generateStandIn(
      request('NATIONAL_ID', 'UK_NHS', 'GB', '943 476 5919'),
      seed(2),
      0,
    );
    expect(nhs?.value).toMatch(/^999 \d{3} \d{4}$/u);
    expect(await detected(`NHS ${nhs?.value ?? ''}`, 'GB')).toEqual([
      'NATIONAL_ID/UK_NHS',
    ]);
    const card = generateStandIn(
      request('CARD', null, null, '4111 1111 1111 1111'),
      seed(2),
      0,
    );
    expect(TEST_CARDS.visa).toContain(alphanumerics(card?.value ?? ''));
    expect(await detected(`card ${card?.value ?? ''}`, 'GB')).toEqual([
      'CARD/-',
    ]);
    const aws = generateStandIn(
      request('SECRET', null, null, `AKIA${'Q'.repeat(15)}7`),
      seed(2),
      0,
    );
    expect(aws?.value).toBe(AWS_EXAMPLE_ACCESS_KEY_ID);
  });

  it('moves on to new test cards attempt by attempt, then to random numbers', () => {
    const real = request('CARD', null, null, '4111111111111111');
    const values = Array.from(
      { length: RESERVED_ATTEMPTS },
      (_, attempt) => generateStandIn(real, seed(4), attempt)?.value,
    );
    expect(new Set(values).size).toBe(RESERVED_ATTEMPTS);
    expect(values.every((value) => TEST_CARDS.visa.includes(value ?? ''))).toBe(
      true,
    );
    // Amex has two test numbers: attempt 2 is already random.
    const amex = request('CARD', null, null, '371449635398431');
    expect(generateStandIn(amex, seed(4), 0)?.value).toBe('378282246310005');
    expect(generateStandIn(amex, seed(4), 1)?.reserved).toBe(false);
  });
});

describe('facts encoded in IDs', () => {
  const DAY = 86_400_000;

  it('CN: birth date shifted by the offset, sex kept, province kept', () => {
    for (const value of ['11010519491231002X', '360426199101010071']) {
      const real = request('NATIONAL_ID', 'CN_RIC', 'CN', value);
      for (let n = 0; n < 50; n += 1) {
        const standIn = generateStandIn(real, seed(n), 0)?.value ?? '';
        const born = (id: string) =>
          Date.UTC(
            Number(id.slice(6, 10)),
            Number(id.slice(10, 12)) - 1,
            Number(id.slice(12, 14)),
          );
        expect(Math.abs(born(standIn) - born(value)) / DAY).toBe(
          Math.abs(OFFSET),
        );
        expect(Number(standIn.charAt(16)) % 2).toBe(
          Number(value.charAt(16)) % 2,
        );
        expect(standIn.slice(0, 2)).toBe(value.slice(0, 2));
      }
    }
  });

  it('ZA: date shifted, sex half, citizenship and fourth group kept', () => {
    const value = '7503305044089';
    const real = request('NATIONAL_ID', 'ZA_ID', 'ZA', value);
    for (let n = 0; n < 50; n += 1) {
      const standIn = generateStandIn(real, seed(n), 0)?.value ?? '';
      // 1975-03-30 − 120 days = 1974-11-30.
      expect(standIn.slice(0, 6)).toBe('741130');
      expect(Number(standIn.slice(6, 10))).toBeGreaterThanOrEqual(5000);
      expect(standIn.slice(10, 12)).toBe('08');
    }
  });

  it('IT: date shifted, women keep day + 40, omocodia letters stay letters', () => {
    const female =
      generateStandIn(
        request('NATIONAL_ID', 'IT_CF', 'IT', 'CNTCHR83T41D969D'),
        seed(1),
        0,
      )?.value ?? '';
    // 1983-12-01 − 120 days = 1983-08-03, month M, day 43.
    expect(female.slice(6, 11)).toBe('83M43');
    // RCCMNL83S18D969H with its last digit as the omocodia letter V (9).
    const payload = 'RCCMNL83S18D96V';
    const omocodic = `${payload}${cfCheckLetter(payload) ?? ''}`;
    const standIn =
      generateStandIn(
        request('NATIONAL_ID', 'IT_CF', 'IT', omocodic),
        seed(1),
        0,
      )?.value ?? '';
    expect(standIn.charAt(14)).toMatch(/[LMNPQRSTUV]/u);
    expect(standIn.slice(12, 14)).toMatch(/^\d\d$/u);
  });

  it('FR: sex digit kept, birth month shifted, Corsica kept', () => {
    const standIn =
      generateStandIn(
        request('NATIONAL_ID', 'FR_NIR', 'FR', '2 95 10 99 126 111 93'),
        seed(1),
        0,
      )?.value ?? '';
    // October 1995 − 120 days (from the 15th) = June 1995; born abroad (99).
    expect(standIn.slice(0, 11)).toBe('2 95 06 99 ');
    const corsica =
      generateStandIn(
        request('NATIONAL_ID', 'FR_NIR', 'FR', '253072B07300470'),
        seed(1),
        0,
      )?.value ?? '';
    expect(corsica.slice(0, 7)).toBe('253032B');
  });

  it('never shifts a birth date into the future', () => {
    // Born 2026-10-01 (check character computed here; not a real number).
    const payload = '11010520261001001';
    const value = `${payload}${mod11_2CheckCharacter(payload) ?? ''}`;
    const forward = {
      ...request('NATIONAL_ID', 'CN_RIC', 'CN', value),
      dateOffsetDays: 200,
    };
    const standIn = generateStandIn(forward, seed(1), 0)?.value ?? '';
    // 200 days later is after today, so 200 days earlier: 2026-03-15.
    expect(standIn.slice(6, 14)).toBe('20260315');
  });
});

describe('secret stand-ins', () => {
  it('keeps the kind of an encoded secret and its algorithm', () => {
    const [jwt = '', basic = '', pem = ''] = ENCODED_SECRETS;
    const jwtStandIn =
      generateStandIn(request('SECRET', null, null, jwt), seed(1), 0)?.value ??
      '';
    const [header = ''] = jwtStandIn.split('.');
    expect(
      JSON.parse(Buffer.from(header, 'base64url').toString('utf8')),
    ).toEqual({ alg: 'HS256', typ: 'JWT' });
    expect(jwtStandIn.split('.')[2]).toHaveLength(
      jwt.split('.')[2]?.length ?? 0,
    );
    const basicStandIn =
      generateStandIn(request('SECRET', null, null, basic), seed(1), 0)
        ?.value ?? '';
    const decoded = Buffer.from(basicStandIn, 'base64').toString('utf8');
    expect(decoded).toMatch(
      /^[a-z]{4}\.[a-z]{4}:[a-z]{3}-[a-z]-[a-z]{4}-[a-z]{8}-\d\d$/u,
    );
    const pemStandIn =
      generateStandIn(request('SECRET', null, null, pem), seed(1), 0)?.value ??
      '';
    expect(pemStandIn.split('\n')[0]).toBe(pem.split('\n')[0]);
    expect(pemStandIn.split('\n').at(-1)).toBe(pem.split('\n').at(-1));
  });

  it('keeps a vendor prefix and a hexadecimal alphabet', () => {
    const github = SECRET_TOKENS.GITHUB_TOKEN ?? '';
    expect(
      generateStandIn(request('SECRET', null, null, github), seed(3), 0)?.value,
    ).toMatch(/^ghp_[A-Za-z0-9]{36}$/u);
    expect(
      generateStandIn(
        request('SECRET', null, null, 'a3f9c1d27b8e4f6051c2d3e4f5a6b7c8'),
        seed(3),
        0,
      )?.value,
    ).toMatch(/^[0-9a-f]{32}$/u);
  });
});

describe('unsupported types', () => {
  it('throws for a type without a generator', () => {
    for (const real of [
      request('PERSON', null, null, 'Dana Whitfield'),
      request('BANK', 'SWIFT_BIC', null, 'DEUTDEFF'),
      request('NATIONAL_ID', null, null, '123'),
    ]) {
      expect(() => generateStandIn(real, seed(1), 0)).toThrow(StandInError);
    }
  });
});
