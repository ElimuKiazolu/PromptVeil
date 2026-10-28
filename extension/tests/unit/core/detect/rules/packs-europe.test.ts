/**
 * Country packs ES, IT, FR, DE (TR-R1), under the test-data policy:
 * documented examples with their sources plus seeded property tests
 * (numbers generated in memory only).
 */
import { describe, expect, it } from 'vitest';
import type { CountryCode } from '@/src/shared/country.ts';
import type { EntityType } from '@/src/shared/entities.ts';
import { mod11_10CheckDigit, mod23Letter } from '@/src/core/detect/checksum.ts';
import { detectRules } from '@/src/core/detect/rules/detector.ts';
import { COUNTRY_PACKS } from '@/src/core/detect/rules/packs/index.ts';
import { isValidTaxId } from '@/src/core/detect/rules/packs/de.ts';
import { isValidDni } from '@/src/core/detect/rules/packs/es.ts';
import { isValidNir, nirKey } from '@/src/core/detect/rules/packs/fr.ts';
import { cfCheckLetter, isValidCf } from '@/src/core/detect/rules/packs/it.ts';

const IDS = new Set<EntityType>(['NATIONAL_ID']);

async function detectIds(text: string, homeRegions: CountryCode[] = []) {
  const detections = await detectRules(text, {
    homeRegions,
    entityTypes: IDS,
    packs: COUNTRY_PACKS,
    exclude: [],
  });
  return detections.map((d) => [d.subtype, d.value, d.status]);
}

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

function replaceAt(value: string, at: number, char: string): string {
  return `${value.slice(0, at)}${char}${value.slice(at + 1)}`;
}

function* digitSubstitutions(
  value: string,
  positions: readonly number[],
): Generator<string> {
  for (const at of positions) {
    for (let digit = 0; digit <= 9; digit += 1) {
      const replacement = digit.toString();
      if (replacement !== value.charAt(at))
        yield replaceAt(value, at, replacement);
    }
  }
}

function* neighbourSwaps(
  value: string,
  positions: readonly number[],
): Generator<string> {
  for (const at of positions) {
    const a = value.charAt(at);
    const b = value.charAt(at + 1);
    if (a !== b) yield `${value.slice(0, at)}${b}${a}${value.slice(at + 2)}`;
  }
}

const range = (from: number, to: number): number[] =>
  Array.from({ length: to - from }, (_, i) => from + i);

const RUNS = 300;

describe('ES_DNI (DNI and NIE)', () => {
  it.each([
    // Ministerio del Interior check-letter examples (also in the P2.1 tests).
    '12345678Z',
    '00000000T',
    '12345678-Z',
    '12345678 z',
    // python-stdnum es.dni documentation example.
    '54362315-K',
    // NIE: Ministerio del Interior example and python-stdnum es.nie example.
    'X1234567L',
    'X-2482300-W',
    'x2482300w',
  ])('accepts %s', (value) => {
    expect(isValidDni(value)).toBe(true);
  });

  it.each([
    // python-stdnum documentation: wrong letter, digit missing.
    ['wrong letter', '54362315Z'],
    ['NIE, wrong letter', 'X2482300A'],
    ['seven digits', '1234567Z'],
    ['NIE prefix W', 'W1234567L'],
    ['two separators', '12345678--Z'],
  ])('rejects %s (%s)', (_, value) => {
    expect(isValidDni(value)).toBe(false);
  });

  it('is found with or without a context word, but not after a reference word', async () => {
    expect(await detectIds('Mi DNI es 12345678-Z.')).toEqual([
      ['ES_DNI', '12345678-Z', 'confirmed'],
    ]);
    expect(await detectIds('NIE X1234567L')).toEqual([
      ['ES_DNI', 'X1234567L', 'confirmed'],
    ]);
    expect(await detectIds('Order 12345678Z shipped')).toEqual([]);
  });

  it('checksum property: mod 23 catches every single-digit change and neighbour swap', () => {
    const next = seeded(801);
    for (let run = 0; run < RUNS; run += 1) {
      const digits = digitsFrom(next, 8);
      const dni = `${digits}${mod23Letter(digits) ?? ''}`;
      expect(isValidDni(dni), dni).toBe(true);
      for (const changed of digitSubstitutions(dni, range(0, 8))) {
        expect(isValidDni(changed), changed).toBe(false);
      }
      for (const swapped of neighbourSwaps(dni, range(0, 7))) {
        expect(isValidDni(swapped), swapped).toBe(false);
      }
    }
  });
});

describe('IT_CF', () => {
  it.each([
    // python-stdnum it.codicefiscale documentation examples (male; female, day 41).
    'RCCMNL83S18D969H',
    'CNTCHR83T41D969D',
    // The "Mario Rossi" example used throughout codice fiscale documentation.
    'RSSMRA85T10A562S',
  ])('accepts %s', (value) => {
    expect(isValidCf(value)).toBe(true);
  });

  it('accepts omocodic codes (digits replaced by letters, check letter recomputed)', () => {
    // RCCMNL83S18D969H with the last numeric digits replaced, right to left.
    for (const payload of [
      'RCCMNL83S18D96V',
      'RCCMNL83S18D9SV',
      'RCCMNL83S1UD9SV',
    ]) {
      const cf = `${payload}${cfCheckLetter(payload) ?? ''}`;
      expect(isValidCf(cf), cf).toBe(true);
    }
  });

  it.each([
    // python-stdnum documentation: 15 characters.
    ['fifteen characters', 'RCCMNL83S18D969'],
    ['wrong check letter', 'RCCMNL83S18D969A'],
    ['month letter F', 'RCCMNL83F18D969H'],
    ['day 32', 'RCCMNL83S32D969H'],
    ['day 72', 'RCCMNL83S72D969H'],
    ['lower case', 'rccmnl83s18d969h'],
  ])('rejects %s (%s)', (_, value) => {
    expect(isValidCf(value)).toBe(false);
  });

  it('is found without a context word, but not after a reference word', async () => {
    expect(await detectIds('Codice fiscale: RCCMNL83S18D969H')).toEqual([
      ['IT_CF', 'RCCMNL83S18D969H', 'confirmed'],
    ]);
    expect(await detectIds('SKU RCCMNL83S18D969H')).toEqual([]);
  });

  it('checksum property: any other digit in a numeric position changes the check letter', () => {
    const next = seeded(802);
    const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    const letter = (): string => letters.charAt(Math.floor(next() * 26));
    const numeric = [6, 7, 9, 10, 12, 13, 14];
    for (let run = 0; run < RUNS; run += 1) {
      const day = 1 + Math.floor(next() * 28) + (next() < 0.5 ? 0 : 40);
      const payload = `${letter()}${letter()}${letter()}${letter()}${letter()}${letter()}${digitsFrom(next, 2)}${'ABCDEHLMPRST'.charAt(Math.floor(next() * 12))}${day.toString().padStart(2, '0')}${next() < 0.2 ? 'Z' : letter()}${digitsFrom(next, 3)}`;
      const cf = `${payload}${cfCheckLetter(payload) ?? ''}`;
      expect(isValidCf(cf), cf).toBe(true);
      for (const changed of digitSubstitutions(cf, numeric)) {
        // Some substitutions also break the day; either way the code is invalid.
        expect(isValidCf(changed), changed).toBe(false);
      }
    }
  });
});

describe('FR_NIR', () => {
  it.each([
    // python-stdnum fr.nir documentation examples, incl. Corsica 2A and 2B.
    '2 95 10 99 126 111 93',
    '295109912611193',
    '253072B07300470',
    '253072A07300443',
    // French teaching-material worked example (fixture identity).
    '2 91 01 75 018 002 68',
    // Spaced form from the P3.3 specification.
    '1 84 12 76 451 089 46',
  ])('accepts %s', (value) => {
    expect(isValidNir(value)).toBe(true);
  });

  it.each([
    // python-stdnum documentation: wrong key, department 2C, 16 digits.
    ['wrong key', '295109912611199'],
    ['department 2C', '253072C07300443'],
    ['sixteen digits', '6546546546546703'],
    ['sex digit 5', '595109912611193'],
    ['month 14', '295149912611193'],
    ['department 00', '295100012611193'],
  ])('rejects %s (%s)', (_, value) => {
    expect(isValidNir(value)).toBe(false);
  });

  it('accepts the INSEE pseudo-months for unknown birth dates', () => {
    for (const month of ['13', '20', '31', '42', '50', '99']) {
      // Sex 1, year 84, the month under test, department 76, commune 451, order 089.
      const first13 = `184${month}76451089`;
      const nir = `${first13}${nirKey(first13) ?? ''}`;
      expect(isValidNir(nir), nir).toBe(true);
    }
  });

  it('is found without a context word', async () => {
    expect(
      await detectIds('Numéro de sécurité sociale : 1 84 12 76 451 089 46'),
    ).toEqual([['FR_NIR', '1 84 12 76 451 089 46', 'confirmed']]);
  });

  it('checksum property: the key catches every single-digit change and neighbour swap', () => {
    const next = seeded(803);
    for (let run = 0; run < RUNS; run += 1) {
      const first13 = `${'12'.charAt(Math.floor(next() * 2))}${digitsFrom(next, 2)}${(1 + Math.floor(next() * 12)).toString().padStart(2, '0')}${(1 + Math.floor(next() * 95)).toString().padStart(2, '0')}${(1 + Math.floor(next() * 998)).toString().padStart(3, '0')}${(1 + Math.floor(next() * 998)).toString().padStart(3, '0')}`;
      const nir = `${first13}${nirKey(first13) ?? ''}`;
      expect(isValidNir(nir), nir).toBe(true);
      for (const changed of digitSubstitutions(nir, range(0, 13))) {
        expect(isValidNir(changed), changed).toBe(false);
      }
      for (const swapped of neighbourSwaps(nir, range(0, 12))) {
        expect(isValidNir(swapped), swapped).toBe(false);
      }
    }
  });
});

describe('DE_TAXID', () => {
  it.each([
    // python-stdnum de.idnr documentation example.
    '36 574 261 809',
    '36574261809',
    // Published examples (P2.1 checksum tests; fixture identity).
    '86095742719',
    '65929970489',
  ])('accepts %s', (value) => {
    expect(isValidTaxId(value)).toBe(true);
  });

  it.each([
    // python-stdnum documentation: wrong check digit, too many repeated digits.
    ['wrong check digit', '36574261890'],
    ['digits repeated too often', '36554266806'],
    ['first digit 0', '06574261809'],
    [
      'no digit repeated',
      '1234567890' + String(mod11_10CheckDigit('1234567890') ?? ''),
    ],
    [
      'three equal digits adjacent',
      '1112345678' + String(mod11_10CheckDigit('1112345678') ?? ''),
    ],
    ['irregular grouping', '365 742 618 09'],
  ])('rejects %s (%s)', (_, value) => {
    expect(isValidTaxId(value)).toBe(false);
  });

  it('accepts a digit three times when not all adjacent', () => {
    const first10 = '1121345678';
    expect(
      isValidTaxId(`${first10}${String(mod11_10CheckDigit(first10))}`),
    ).toBe(true);
  });

  it('is found without a context word, and with a Steuer-ID word', async () => {
    expect(await detectIds('Steuer-ID 36 574 261 809')).toEqual([
      ['DE_TAXID', '36 574 261 809', 'confirmed'],
    ]);
  });

  it('checksum property: MOD 11,10 catches every single-digit change', () => {
    const next = seeded(804);
    for (let run = 0; run < RUNS; run += 1) {
      // Nine distinct digits plus one repeated, first digit not 0.
      const pool = '0123456789'.split('').sort(() => next() - 0.5);
      const digits = pool.slice(0, 9);
      digits.push(digits[Math.floor(next() * 9)] ?? '1');
      digits.sort(() => next() - 0.5);
      const first10 = digits.join('');
      if (first10.startsWith('0') || /(\d)\1\1/u.test(first10)) continue;
      const id = `${first10}${String(mod11_10CheckDigit(first10))}`;
      expect(isValidTaxId(id), id).toBe(true);
      for (const changed of digitSubstitutions(id, range(0, 11))) {
        expect(isValidTaxId(changed), changed).toBe(false);
      }
    }
  });
});
