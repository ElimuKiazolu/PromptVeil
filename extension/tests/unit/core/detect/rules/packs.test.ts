/**
 * Country packs US, GB, CA, BR (TR-R1).
 *
 * Valid examples are published test values or documented examples, each
 * labelled with its source; none is known to belong to a real person. The
 * seeded property tests generate many more valid numbers in memory (never
 * written anywhere) and check that the checksums catch the errors they
 * guarantee to catch.
 */
import { describe, expect, it } from 'vitest';
import type { CountryCode } from '@/src/shared/country.ts';
import type { EntityType } from '@/src/shared/entities.ts';
import { detectRules } from '@/src/core/detect/rules/detector.ts';
import {
  COUNTRY_PACKS,
  assertValidPack,
  type CountryPack,
} from '@/src/core/detect/rules/packs/index.ts';
import {
  BR_PACK,
  cpfCheckDigits,
  isValidCpf,
} from '@/src/core/detect/rules/packs/br.ts';
import { CA_PACK, isValidSin } from '@/src/core/detect/rules/packs/ca.ts';
import {
  GB_PACK,
  isValidNhsNumber,
  isValidNino,
  nhsCheckDigit,
} from '@/src/core/detect/rules/packs/gb.ts';
import { US_PACK, isValidSsn } from '@/src/core/detect/rules/packs/us.ts';
import { luhnCheckDigit } from '@/src/core/detect/checksum.ts';

const IDS = new Set<EntityType>(['NATIONAL_ID']);

async function detectIds(
  text: string,
  homeRegions: CountryCode[] = [],
  packs: readonly CountryPack[] = COUNTRY_PACKS,
) {
  const detections = await detectRules(text, {
    homeRegions,
    entityTypes: IDS,
    packs,
    exclude: [],
  });
  return detections.map((d) => [d.subtype, d.value, d.status]);
}

/** Fixed linear congruential sequence: the same numbers on every run. */
function seeded(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };
}

function digitsFrom(next: () => number, count: number): string {
  let out = '';
  for (let i = 0; i < count; i += 1) out += Math.floor(next() * 10).toString();
  return out;
}

/** Every value with one digit replaced by another. */
function* substitutions(
  value: string,
): Generator<{ at: number; value: string }> {
  for (let at = 0; at < value.length; at += 1) {
    for (let digit = 0; digit <= 9; digit += 1) {
      const replacement = digit.toString();
      if (replacement === value.charAt(at)) continue;
      yield {
        at,
        value: `${value.slice(0, at)}${replacement}${value.slice(at + 1)}`,
      };
    }
  }
}

/** Every value with two different neighbouring digits swapped. */
function* transpositions(
  value: string,
): Generator<{ pair: string; value: string }> {
  for (let at = 0; at + 1 < value.length; at += 1) {
    const a = value.charAt(at);
    const b = value.charAt(at + 1);
    if (a === b) continue;
    yield {
      pair: `${a}${b}`,
      value: `${value.slice(0, at)}${b}${a}${value.slice(at + 2)}`,
    };
  }
}

const RUNS = 300;

describe('pack template', () => {
  it.each(COUNTRY_PACKS.map((pack) => [pack.country, pack] as const))(
    '%s pack is well formed and its stand-in specs use its own validators',
    (_, pack) => {
      expect(() => {
        assertValidPack(pack);
      }).not.toThrow();
      for (const rule of pack.rules) {
        expect(rule.type).toBe('NATIONAL_ID');
        expect(rule.subtype).not.toBeNull();
      }
    },
  );
});

describe('US_SSN', () => {
  it.each([
    // python-stdnum documentation, us.ssn: validate('536-90-4399').
    '536-90-4399',
    // python-stdnum documentation, us.ssn: format('111223333').
    '111-22-3333',
    // Django localflavor US SSN field tests (ticket 17591).
    '123-45-6789',
    '123 45 6789',
    '123456789',
  ])('accepts %s', (value) => {
    expect(isValidSsn(value)).toBe(true);
  });

  it.each([
    // SSA advertising range 987-65-4320 to 4329 (area 9xx); fixture identity.
    ['advertising range', '987-65-4321'],
    // Voided by the SSA: the "Woolworth" wallet card number.
    ['voided wallet card number', '078-05-1120'],
    // Voided by the SSA: 1940 pamphlet specimen.
    ['voided pamphlet number', '219-09-9999'],
    // python-stdnum documentation: invalid area.
    ['area 666', '666-00-0000'],
    ['area 000', '000-12-1234'],
    ['area 900–999', '900-12-1234'],
    ['group 00', '123-00-1234'],
    ['serial 0000', '123-12-0000'],
    ['mixed separators', '123-45 6789'],
    // python-stdnum documentation: dash in the wrong place.
    ['wrong grouping', '1112-23333'],
  ])('rejects %s (%s)', (_, value) => {
    expect(isValidSsn(value)).toBe(false);
  });

  it('needs a context word for nine plain digits, not for the dashed form', async () => {
    expect(await detectIds('ref 536904399 ok', ['US'])).toEqual([]);
    expect(await detectIds('My SSN is 536904399', ['US'])).toEqual([
      ['US_SSN', '536904399', 'confirmed'],
    ]);
    expect(await detectIds('Number 536-90-4399 on file')).toEqual([
      ['US_SSN', '536-90-4399', 'confirmed'],
    ]);
  });

  it('rule property: generated SSNs validate', () => {
    const next = seeded(101);
    for (let run = 0; run < RUNS; run += 1) {
      const area = 1 + Math.floor(next() * 899);
      if (area === 666) continue;
      const group = 1 + Math.floor(next() * 99);
      const serial = 1 + Math.floor(next() * 9999);
      const ssn = `${area.toString().padStart(3, '0')}-${group.toString().padStart(2, '0')}-${serial.toString().padStart(4, '0')}`;
      if (ssn === '078-05-1120' || ssn === '219-09-9999') continue;
      expect(isValidSsn(ssn), ssn).toBe(true);
    }
  });
});

describe('UK_NINO', () => {
  it.each([
    // Common tutorial example (nino-validator README and others).
    'AB123456C',
    'AB 12 34 56 C',
    // HMRC sandbox test users, sample responses of the Create Test User API
    // (WebService::HMRC::CreateTestUser README): fictional sandbox identities.
    'PE938808A',
    'XM110477D',
    // nino-validator README: generated example.
    'JG123789A',
  ])('accepts %s', (value) => {
    expect(isValidNino(value)).toBe(true);
  });

  it.each([
    // HMRC NIM39110 format example; Q is never a prefix letter (fixture identity).
    ['format example QQ', 'QQ 12 34 56 A'],
    // nino-validator README: invalid prefix BG.
    ['reserved prefix BG', 'BG123456C'],
    ['reserved prefix ZZ', 'ZZ123456C'],
    ['reserved prefix NK', 'NK123456C'],
    // nino-validator README: first letter D.
    ['first letter D', 'DA123456C'],
    ['second letter O', 'AO123456C'],
    ['second letter V', 'AV123456C'],
    ['suffix E', 'AB123456E'],
    ['five digits', 'AB12345C'],
    ['irregular spacing', 'AB 1234 56 C'],
  ])('rejects %s (%s)', (_, value) => {
    expect(isValidNino(value)).toBe(false);
  });

  it('is found with or without a context word, upper case only', async () => {
    expect(await detectIds('NI number: AB 12 34 56 C.')).toEqual([
      ['UK_NINO', 'AB 12 34 56 C', 'confirmed'],
    ]);
    expect(await detectIds('code AB123456C here')).toEqual([
      ['UK_NINO', 'AB123456C', 'confirmed'],
    ]);
    expect(await detectIds('id ab123456c')).toEqual([]);
    expect(await detectIds('order AB123456C')).toEqual([]);
  });

  it('rule property: generated NINOs with allowed prefixes validate', () => {
    const next = seeded(202);
    const allowedFirst = 'ABCEGHJKLMNOPRSTWXYZ';
    const allowedSecond = 'ABCEGHJKLMNPRSTWXYZ';
    let checked = 0;
    for (let run = 0; run < RUNS; run += 1) {
      const prefix =
        allowedFirst.charAt(Math.floor(next() * allowedFirst.length)) +
        allowedSecond.charAt(Math.floor(next() * allowedSecond.length));
      if (['GB', 'KN', 'NK', 'NT', 'TN', 'ZZ', 'BG'].includes(prefix)) continue;
      const nino = `${prefix}${digitsFrom(next, 6)}${'ABCD'.charAt(Math.floor(next() * 4))}`;
      expect(isValidNino(nino), nino).toBe(true);
      checked += 1;
    }
    expect(checked).toBeGreaterThan(RUNS * 0.9);
  });
});

describe('UK_NHS', () => {
  it.each([
    // NHS England reserves 999 000 0000 to 999 999 9999 for testing.
    '999 000 0018',
    '999-000-0026',
    '9990000034',
    '999 111 2227',
    '999 000 0093',
    // NHS number example used in NHS Digital documentation of the check digit.
    '943 476 5919',
  ])('accepts %s', (value) => {
    expect(isValidNhsNumber(value)).toBe(true);
  });

  it.each([
    ['wrong check digit', '943 476 5918'],
    ['transposed digits', '934 476 5919'],
    // 999 000 000 has check value 10: no valid NHS number.
    ['check value 10', '999 000 0000'],
    ['all one digit', '000 000 0000'],
    ['mixed separators', '999 000-0018'],
    ['3-4-3 grouping', '999 0000 018'],
  ])('rejects %s (%s)', (_, value) => {
    expect(isValidNhsNumber(value)).toBe(false);
  });

  it('needs a context word for ten plain digits', async () => {
    expect(await detectIds('ticket 9990000018 closed')).toEqual([]);
    expect(await detectIds('NHS number 9990000018')).toEqual([
      ['UK_NHS', '9990000018', 'confirmed'],
    ]);
    expect(await detectIds('Patient 999 000 0018 seen')).toEqual([
      ['UK_NHS', '999 000 0018', 'confirmed'],
    ]);
  });

  it('checksum property: every single-digit change and neighbour swap is caught', () => {
    const next = seeded(303);
    let numbers = 0;
    while (numbers < RUNS) {
      const payload = digitsFrom(next, 9);
      const check = nhsCheckDigit(payload);
      if (check === null) continue;
      const nhs = `${payload}${check}`;
      if (/^(\d)\1*$/u.test(nhs)) continue;
      numbers += 1;
      expect(isValidNhsNumber(nhs), nhs).toBe(true);
      for (const changed of substitutions(nhs)) {
        expect(isValidNhsNumber(changed.value), changed.value).toBe(false);
      }
      for (const swapped of transpositions(nhs)) {
        expect(isValidNhsNumber(swapped.value), swapped.value).toBe(false);
      }
    }
  });
});

describe('CA_SIN', () => {
  it.each([
    // python-stdnum documentation, ca.sin: validate('123-456-782').
    '123-456-782',
    '123 456 782',
    '123456782',
  ])('accepts %s', (value) => {
    expect(isValidSin(value)).toBe(true);
  });

  it.each([
    // Wikipedia's "fictitious but valid" example: first digit 0 (fixture identity).
    ['first digit 0', '046 454 286'],
    // Exercism Luhn test suite "valid Canadian SIN": Luhn-valid, first digit 0.
    ['first digit 0 (Luhn valid)', '055 444 285'],
    // python-stdnum documentation: invalid component (first digit 8).
    ['first digit 8', '823456785'],
    // python-stdnum documentation: invalid checksum.
    ['bad check digit', '999-999-999'],
    ['changed digit', '123 456 783'],
    ['mixed separators', '123-456 782'],
  ])('rejects %s (%s)', (_, value) => {
    expect(isValidSin(value)).toBe(false);
  });

  it('needs a context word for nine plain digits', async () => {
    expect(await detectIds('code 123456782', ['CA'])).toEqual([]);
    expect(await detectIds('Mon NAS : 123456782', ['CA'])).toEqual([
      ['CA_SIN', '123456782', 'confirmed'],
    ]);
    expect(await detectIds('SIN 123 456 782', ['CA'])).toEqual([
      ['CA_SIN', '123 456 782', 'confirmed'],
    ]);
  });

  it('checksum property: single-digit changes and swaps are caught (Luhn misses only 09/90)', () => {
    const next = seeded(404);
    let numbers = 0;
    while (numbers < RUNS) {
      const first = '12345679'.charAt(Math.floor(next() * 8));
      const payload = `${first}${digitsFrom(next, 7)}`;
      const sin = `${payload}${String(luhnCheckDigit(payload))}`;
      numbers += 1;
      expect(isValidSin(sin), sin).toBe(true);
      for (const changed of substitutions(sin)) {
        expect(isValidSin(changed.value), changed.value).toBe(false);
      }
      for (const swapped of transpositions(sin)) {
        if (swapped.pair === '09' || swapped.pair === '90') continue;
        expect(isValidSin(swapped.value), swapped.value).toBe(false);
      }
    }
  });
});

describe('BR_CPF', () => {
  it.each([
    // python-stdnum documentation, br.cpf: validate('390.533.447-05').
    '390.533.447-05',
    '39053344705',
    // valorfinal.com.br check-digit guide example (fixture identity).
    '111.444.777-35',
    // dio.me "Como criar um validador de CPF com Python" worked example.
    '529.982.247-25',
    // Unicamp MC102 exam exercise base 222.333.666, check digits computed.
    '222.333.666-38',
  ])('accepts %s', (value) => {
    expect(isValidCpf(value)).toBe(true);
  });

  it.each([
    // python-stdnum documentation: invalid checksum.
    ['bad check digits', '231.002.999-00'],
    ['one repeated digit', '111.111.111-11'],
    ['all zeros', '000.000.000-00'],
    ['changed check digit', '390.533.447-06'],
    // python-stdnum documentation: invalid delimiter.
    ['wrong delimiter', '390.533.447=05'],
    ['partly formatted', '390533.447-05'],
  ])('rejects %s (%s)', (_, value) => {
    expect(isValidCpf(value)).toBe(false);
  });

  it('is found formatted or plain, and not after a reference word', async () => {
    expect(await detectIds('CPF: 390.533.447-05')).toEqual([
      ['BR_CPF', '390.533.447-05', 'confirmed'],
    ]);
    expect(await detectIds('documento 39053344705')).toEqual([
      ['BR_CPF', '39053344705', 'confirmed'],
    ]);
    expect(await detectIds('invoice 39053344705')).toEqual([]);
  });

  it('checksum property: changes to the check digits are always caught, others almost always', () => {
    const next = seeded(505);
    let changes = 0;
    let caught = 0;
    for (let run = 0; run < RUNS; run += 1) {
      const payload = digitsFrom(next, 9);
      const cpf = `${payload}${cpfCheckDigits(payload) ?? ''}`;
      if (/^(\d)\1*$/u.test(cpf)) continue;
      expect(isValidCpf(cpf), cpf).toBe(true);
      for (const changed of substitutions(cpf)) {
        if (changed.at >= 9) {
          expect(isValidCpf(changed.value), changed.value).toBe(false);
          continue;
        }
        changes += 1;
        if (!isValidCpf(changed.value)) caught += 1;
      }
    }
    // Remainders 0 and 1 both give check digit 0, so a few base-digit
    // changes keep both check digits; measured above 99 %.
    expect(caught / changes).toBeGreaterThan(0.99);
  });
});

describe('packs together', () => {
  it('the four packs run through the detector with their own country', async () => {
    const text =
      'SSN 536-90-4399, NI number AB 12 34 56 C, NHS 999 000 0018, SIN 123 456 782, CPF 390.533.447-05.';
    const detections = await detectRules(text, {
      homeRegions: [],
      entityTypes: IDS,
      packs: [US_PACK, GB_PACK, CA_PACK, BR_PACK],
      exclude: [],
    });
    expect(detections.map((d) => [d.subtype, d.country, d.status])).toEqual([
      ['US_SSN', 'US', 'confirmed'],
      ['UK_NINO', 'GB', 'confirmed'],
      ['UK_NHS', 'GB', 'confirmed'],
      ['CA_SIN', 'CA', 'confirmed'],
      ['BR_CPF', 'BR', 'confirmed'],
    ]);
  });
});
