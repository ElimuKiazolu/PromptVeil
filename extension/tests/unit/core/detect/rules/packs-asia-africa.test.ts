/**
 * Country packs IN, CN, SG, ZA (TR-R1), under the test-data policy: official
 * test values or documented examples with their sources, plus seeded
 * property tests (numbers generated in memory only).
 */
import { describe, expect, it } from 'vitest';
import type { CountryCode } from '@/src/shared/country.ts';
import type { EntityType } from '@/src/shared/entities.ts';
import {
  isValidLuhn,
  luhnCheckDigit,
  mod11_2CheckCharacter,
  verhoeffCheckDigit,
} from '@/src/core/detect/checksum.ts';
import { detectRules } from '@/src/core/detect/rules/detector.ts';
import { COUNTRY_PACKS } from '@/src/core/detect/rules/packs/index.ts';
import { isValidRic } from '@/src/core/detect/rules/packs/cn.ts';
import {
  isPalindrome,
  isValidAadhaar,
  isValidPan,
  isValidVid,
} from '@/src/core/detect/rules/packs/in.ts';
import {
  isValidNric,
  nricCheckLetter,
} from '@/src/core/detect/rules/packs/sg.ts';
import { isValidZaId } from '@/src/core/detect/rules/packs/za.ts';

const IDS = new Set<EntityType>(['NATIONAL_ID']);
const TODAY = new Date(Date.UTC(2026, 9, 23));

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

function* substitutions(value: string, positions: number): Generator<string> {
  for (let at = 0; at < positions; at += 1) {
    for (let digit = 0; digit <= 9; digit += 1) {
      const replacement = digit.toString();
      if (replacement === value.charAt(at)) continue;
      yield `${value.slice(0, at)}${replacement}${value.slice(at + 1)}`;
    }
  }
}

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
const pad = (n: number, width: number): string =>
  n.toString().padStart(width, '0');

describe('IN_AADHAAR', () => {
  it.each([
    // UIDAI "Testing Data and License Keys": published test UID.
    '999941057058',
    // UIDAI developer tutorial test number (fixture identity).
    '999999990019',
    '9999 9999 0019',
    // python-stdnum in_.aadhaar documentation example.
    '234123412346',
    '2341-2341-2346',
  ])('accepts %s', (value) => {
    expect(isValidAadhaar(value)).toBe(true);
  });

  it.each([
    // python-stdnum documentation: bad checksum, leading 1, repeated digits.
    ['bad check digit', '234123412347'],
    ['first digit 1', '123412341234'],
    ['first digit 0', '023412341234'],
    ['palindrome', '222222222222'],
    ['eleven digits', '99999999001'],
    ['mixed separators', '9999 9999-0019'],
  ])('rejects %s (%s)', (_, value) => {
    expect(isValidAadhaar(value)).toBe(false);
  });

  it('needs a context word for twelve plain digits', async () => {
    expect(await detectIds('ref 999941057058')).toEqual([]);
    expect(await detectIds('code 999941057058', ['IN'])).toEqual([]);
    expect(await detectIds('मेरा आधार 999941057058')).toEqual([
      ['IN_AADHAAR', '999941057058', 'confirmed'],
    ]);
    expect(await detectIds('number 9999 4105 7058')).toEqual([
      ['IN_AADHAAR', '9999 4105 7058', 'confirmed'],
    ]);
  });

  it('checksum property: Verhoeff catches every single-digit change and neighbour swap', () => {
    const next = seeded(611);
    let numbers = 0;
    while (numbers < RUNS) {
      const payload = `${(2 + Math.floor(next() * 8)).toString()}${digitsFrom(next, 10)}`;
      const aadhaar = `${payload}${String(verhoeffCheckDigit(payload))}`;
      if (isPalindrome(aadhaar)) continue;
      numbers += 1;
      expect(isValidAadhaar(aadhaar), aadhaar).toBe(true);
      for (const changed of substitutions(aadhaar, 12)) {
        expect(isValidAadhaar(changed), changed).toBe(false);
      }
      for (const swapped of transpositions(aadhaar)) {
        expect(isValidAadhaar(swapped.value), swapped.value).toBe(false);
      }
    }
  });
});

describe('IN_VID', () => {
  it.each([
    // python-stdnum in_.vid documentation example.
    '2341234123412341',
    '2341 2341 2341 2341',
  ])('accepts %s', (value) => {
    expect(isValidVid(value)).toBe(true);
  });

  it.each([
    // python-stdnum documentation: bad checksum, leading 1, too short, palindrome.
    ['bad check digit', '2341234123412342'],
    ['first digit 1', '1341234123412341'],
    ['fourteen digits', '13412341234123'],
    ['palindrome', '2222222222222222'],
  ])('rejects %s (%s)', (_, value) => {
    expect(isValidVid(value)).toBe(false);
  });

  it('is found only with a VID context word (sixteen digits are also card numbers)', async () => {
    expect(await detectIds('number 2341 2341 2341 2341')).toEqual([]);
    expect(await detectIds('Virtual ID: 2341 2341 2341 2341')).toEqual([
      ['IN_VID', '2341 2341 2341 2341', 'confirmed'],
    ]);
  });

  it('checksum property: generated VIDs validate and single changes fail', () => {
    const next = seeded(612);
    let numbers = 0;
    while (numbers < RUNS / 3) {
      const payload = `${(2 + Math.floor(next() * 8)).toString()}${digitsFrom(next, 14)}`;
      const vid = `${payload}${String(verhoeffCheckDigit(payload))}`;
      if (isPalindrome(vid)) continue;
      numbers += 1;
      expect(isValidVid(vid), vid).toBe(true);
      for (const changed of substitutions(vid, 16)) {
        expect(isValidVid(changed), changed).toBe(false);
      }
    }
  });
});

describe('IN_PAN', () => {
  it.each([
    // python-stdnum in_.pan documentation: valid example and the mask/info
    // example (holder type P, individual).
    'ACUPA7085R',
    'AAPPV8261K',
  ])('accepts %s', (value) => {
    expect(isValidPan(value)).toBe(true);
  });

  it.each([
    // python-stdnum documentation: bad length, digit as check, bad holder
    // type, serial 0000.
    ['eleven characters', 'ACUPA7085RR'],
    ['digit as last character', 'ABMPA32111'],
    ['holder type X', 'ABMXA3211G'],
    ['serial 0000', 'ACUPA0000R'],
    ['lower case', 'acupa7085r'],
  ])('rejects %s (%s)', (_, value) => {
    expect(isValidPan(value)).toBe(false);
  });

  it('is found without a context word, but not after a reference word', async () => {
    expect(await detectIds('my PAN is ACUPA7085R')).toEqual([
      ['IN_PAN', 'ACUPA7085R', 'confirmed'],
    ]);
    expect(await detectIds('code ACUPA7085R')).toEqual([
      ['IN_PAN', 'ACUPA7085R', 'confirmed'],
    ]);
    expect(await detectIds('Order ACUPA7085R shipped')).toEqual([]);
    expect(await detectIds('SKU ACUPA7085R')).toEqual([]);
  });

  it('rule property: every allowed holder type and serial validates', () => {
    const next = seeded(613);
    const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    const letter = (): string => letters.charAt(Math.floor(next() * 26));
    for (let run = 0; run < RUNS; run += 1) {
      const holder = 'PCHFATBLJG'.charAt(Math.floor(next() * 10));
      const serial = pad(1 + Math.floor(next() * 9999), 4);
      const pan = `${letter()}${letter()}${letter()}${holder}${letter()}${serial}${letter()}`;
      expect(isValidPan(pan), pan).toBe(true);
    }
  });
});

describe('CN_RIC', () => {
  it.each([
    // GB 11643-1999 worked example (fixture identity).
    '11010519491231002X',
    '11010519491231002x',
    '110105 19491231 002X',
    // python-stdnum cn.ric documentation example.
    '360426199101010071',
  ])('accepts %s', (value) => {
    expect(isValidRic(value, TODAY)).toBe(true);
  });

  it.each([
    ['wrong check character', '110105194912310021'],
    ['province 99', '99010519491231002X'],
    ['month 13', '110105194913310026'],
    ['born before 1900', '110105189912310028'],
    ['born after today', '110105203012310024'],
    ['15-digit legacy number', '110105491231002'],
    ['irregular grouping', '1101 0519 4912 3100 2X'],
  ])('rejects %s (%s)', (_, value) => {
    expect(isValidRic(value, TODAY)).toBe(false);
  });

  it('is found without a context word', async () => {
    expect(await detectIds('身份证号码：11010519491231002X')).toEqual([
      ['CN_RIC', '11010519491231002X', 'confirmed'],
    ]);
    expect(await detectIds('id 360426199101010071')).toEqual([
      ['CN_RIC', '360426199101010071', 'confirmed'],
    ]);
  });

  it('checksum property: MOD 11-2 catches every single change and neighbour swap', () => {
    const next = seeded(614);
    let numbers = 0;
    while (numbers < RUNS) {
      const province =
        ['11', '31', '44', '51', '65'][Math.floor(next() * 5)] ?? '11';
      const birth = new Date(
        Date.UTC(
          1930 + Math.floor(next() * 90),
          Math.floor(next() * 12),
          1 + Math.floor(next() * 28),
        ),
      );
      const date = `${birth.getUTCFullYear().toString()}${pad(birth.getUTCMonth() + 1, 2)}${pad(birth.getUTCDate(), 2)}`;
      const payload = `${province}${digitsFrom(next, 4)}${date}${digitsFrom(next, 3)}`;
      const ric = `${payload}${mod11_2CheckCharacter(payload) ?? ''}`;
      numbers += 1;
      expect(isValidRic(ric, TODAY), ric).toBe(true);
      for (const changed of substitutions(ric, 17)) {
        expect(isValidRic(changed, TODAY), changed).toBe(false);
      }
      for (const swapped of transpositions(ric)) {
        expect(isValidRic(swapped.value, TODAY), swapped.value).toBe(false);
      }
    }
  });
});

describe('SG_NRIC', () => {
  it.each([
    // singapore-nric library (npm, v2.0.0) test suite: valid numbers of
    // every series, including the 2022 M series; S1234567D is also the
    // fixture identity.
    'S1234567D',
    'S6995241J',
    'T8890856I',
    'F8234009L',
    'G1166318X',
    'M1134985K',
    'S0000001I',
  ])('accepts %s', (value) => {
    expect(isValidNric(value)).toBe(true);
  });

  it.each([
    // singapore-nric test suite: the same numbers with a wrong letter.
    ['S series, wrong letter', 'S1234567A'],
    ['T series, wrong letter', 'T8890856A'],
    ['F series, wrong letter', 'F8234009A'],
    ['G series, wrong letter', 'G1166318A'],
    ['M series, wrong letter', 'M1134985A'],
    // ICA's illustrative example of the M format; not a valid number.
    ['ICA format example', 'M1234567B'],
    ['unknown prefix', 'A1234567D'],
    ['lower case', 's1234567d'],
  ])('rejects %s (%s)', (_, value) => {
    expect(isValidNric(value)).toBe(false);
  });

  it('is found with or without a context word', async () => {
    expect(await detectIds('NRIC S1234567D')).toEqual([
      ['SG_NRIC', 'S1234567D', 'confirmed'],
    ]);
    expect(await detectIds('holder M1134985K')).toEqual([
      ['SG_NRIC', 'M1134985K', 'confirmed'],
    ]);
  });

  it('checksum property: every single-digit change and neighbour swap changes the letter', () => {
    const next = seeded(615);
    for (let run = 0; run < RUNS; run += 1) {
      const prefix = 'STFGM'.charAt(Math.floor(next() * 5));
      const digits = digitsFrom(next, 7);
      const nric = `${prefix}${digits}${nricCheckLetter(prefix, digits) ?? ''}`;
      expect(isValidNric(nric), nric).toBe(true);
      for (const changed of substitutions(digits, 7)) {
        expect(
          isValidNric(`${prefix}${changed}${nric.charAt(8)}`),
          changed,
        ).toBe(false);
      }
      for (const swapped of transpositions(digits)) {
        expect(isValidNric(`${prefix}${swapped.value}${nric.charAt(8)}`)).toBe(
          false,
        );
      }
    }
  });
});

describe('ZA_ID', () => {
  it.each([
    // python-stdnum za.idnr documentation example (and its format()).
    '7503305044089',
    '750330 5044 08 9',
    '750330 5044089',
    // Fixture identity: published checksum-valid example.
    '9807055009087',
  ])('accepts %s', (value) => {
    expect(isValidZaId(value, TODAY)).toBe(true);
  });

  it.each([
    // python-stdnum documentation: bad checksum.
    ['bad check digit', '8503305044089'],
    ['month 13', '7513305044082'],
    ['citizenship 3', '7503305044385'],
    ['born after today', '2712315044082'],
    ['twelve digits', '750330504408'],
    ['irregular grouping', '7503 305044089'],
  ])('rejects %s (%s)', (_, value) => {
    expect(isValidZaId(value, TODAY)).toBe(false);
  });

  it('is found without a context word', async () => {
    expect(await detectIds('ID-nommer 7503305044089')).toEqual([
      ['ZA_ID', '7503305044089', 'confirmed'],
    ]);
  });

  it('checksum property: Luhn catches single changes (and swaps except 09/90)', () => {
    const next = seeded(616);
    let numbers = 0;
    while (numbers < RUNS) {
      const birth = new Date(
        Date.UTC(
          1940 + Math.floor(next() * 80),
          Math.floor(next() * 12),
          1 + Math.floor(next() * 28),
        ),
      );
      const date = `${pad(birth.getUTCFullYear() % 100, 2)}${pad(birth.getUTCMonth() + 1, 2)}${pad(birth.getUTCDate(), 2)}`;
      const payload = `${date}${digitsFrom(next, 4)}${'012'.charAt(Math.floor(next() * 3))}${digitsFrom(next, 1)}`;
      const id = `${payload}${String(luhnCheckDigit(payload))}`;
      numbers += 1;
      expect(isValidZaId(id, TODAY), id).toBe(true);
      expect(isValidLuhn(id)).toBe(true);
      for (const changed of substitutions(id, 13)) {
        expect(isValidZaId(changed, TODAY), changed).toBe(false);
      }
      for (const swapped of transpositions(id)) {
        if (swapped.pair === '09' || swapped.pair === '90') continue;
        expect(isValidZaId(swapped.value, TODAY), swapped.value).toBe(false);
      }
    }
  });
});
