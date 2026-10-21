import { describe, expect, it } from 'vitest';
import {
  getCountries,
  parsePhoneNumberFromString,
  type CountryCode as PhoneRegion,
} from 'libphonenumber-js/max';
import examples from 'libphonenumber-js/mobile/examples';
import {
  buildRegionIndex,
  mayAccept,
} from '@/src/core/detect/validators/phone-regions.ts';
import {
  clearPhoneCache,
  validatePhone,
  validatePhoneSliced,
  warmUpPhone,
} from '@/src/core/detect/validators/phone.ts';
import {
  blockingCheckpoint,
  createCheckpoint,
  runBlocking,
  type Yielder,
} from '@/src/core/detect/schedule.ts';

/** Every region's parse, without the pre-check: the reference result. */
function fullScan(raw: string): string[] {
  const numbers = new Set<string>();
  for (const region of getCountries()) {
    const phone = parsePhoneNumberFromString(raw, {
      defaultCountry: region,
      extract: false,
    });
    if (phone?.isValid()) numbers.add(phone.number);
  }
  return [...numbers].sort();
}

function preChecked(raw: string): string[] {
  const result = validatePhone(raw, []);
  return result.valid ? result.candidates.map((c) => c.e164).sort() : [];
}

/** Deterministic pseudo-random digits (a fixed linear congruential sequence). */
function randomDigits(count: number, seed: number): string[] {
  let state = seed;
  const next = (): number => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };
  const out: string[] = [];
  const prefixes = ['0', '00', '011', '1', '8', '9', '07', '06'];
  for (let i = 0; i < count; i += 1) {
    const length = 7 + Math.floor(next() * 7);
    let digits = '';
    for (let k = 0; k < length; k += 1)
      digits += Math.floor(next() * 10).toString();
    out.push(
      i % 2 === 0
        ? digits
        : `${prefixes[i % prefixes.length] ?? ''}${digits.slice(2)}`,
    );
  }
  return out;
}

/**
 * libphonenumber's own example mobile number for every region, written the
 * national way (with the national prefix and grouping) and as bare digits.
 */
function exampleInputs(): string[] {
  const inputs = new Set<string>();
  for (const [region, nationalNumber] of Object.entries(examples)) {
    const phone = parsePhoneNumberFromString(
      nationalNumber,
      region as PhoneRegion,
    );
    if (phone === undefined) continue;
    const national = phone.formatNational();
    inputs.add(national);
    inputs.add(national.replace(/\D/gu, ''));
  }
  return [...inputs].filter((input) => /^[\d ().\-/]+$/u.test(input));
}

describe('region index', () => {
  it('reads every region, so the pre-check is active everywhere', () => {
    const index = runBlocking(buildRegionIndex());
    expect(index.regions).toHaveLength(getCountries().length);
    expect(index.regions.filter((entry) => entry.alwaysParse)).toEqual([]);
    const unreadable = [...index.callingCodes.values()].filter(
      (entry) => entry.unknownTypes,
    );
    expect(unreadable).toEqual([]);
  });

  it('skips most regions for a typical national number', () => {
    const index = runBlocking(buildRegionIndex());
    const passing = index.regions.filter((entry) =>
      mayAccept(index, entry, '0201234567'),
    );
    expect(passing.length).toBeLessThan(index.regions.length / 2);
  });
});

describe('all-region pass with the pre-check', () => {
  it('gives exactly the full scan result on every region example and on random digits', () => {
    clearPhoneCache();
    const corpus = [...exampleInputs(), ...randomDigits(60, 7)];
    expect(corpus.length).toBeGreaterThan(400);
    const mismatches = corpus.filter(
      (raw) => preChecked(raw).join(',') !== fullScan(raw).join(','),
    );
    expect(mismatches).toEqual([]);
  }, 180_000);

  it('sliced and blocking validation agree and the cache can be cleared', async () => {
    clearPhoneCache();
    // Also a valid US number, so the home region here is GB.
    const blocking = validatePhone('81234 56789', ['GB']);
    clearPhoneCache();
    const sliced = await validatePhoneSliced(
      '81234 56789',
      ['GB'],
      blockingCheckpoint(),
    );
    expect(sliced).toEqual(blocking);
    expect(blocking).toMatchObject({ valid: true, fromHomeRegions: false });
    // libphonenumber's example Indian mobile number, written nationally.
    expect(
      blocking.valid && blocking.candidates.map((c) => c.country),
    ).toContain('IN');
  });

  it('yields between region parses when the slice runs out', async () => {
    clearPhoneCache();
    let clock = 0;
    let yields = 0;
    const yielder: Yielder = {
      // Every reading advances the clock by 1 ms.
      now: () => (clock += 1),
      yieldNow: () => {
        yields += 1;
        return Promise.resolve();
      },
    };
    await validatePhoneSliced(
      '06 12 34 56 78',
      ['US'],
      createCheckpoint(yielder),
    );
    expect(yields).toBeGreaterThan(3);
  });

  it('stops when cancelled', async () => {
    clearPhoneCache();
    const controller = new AbortController();
    controller.abort(new Error('superseded'));
    await expect(
      validatePhoneSliced(
        '030 23125 678',
        [],
        blockingCheckpoint(controller.signal),
      ),
    ).rejects.toThrow('superseded');
  });

  it('warms up in slices', async () => {
    let yields = 0;
    let clock = 0;
    await warmUpPhone(
      createCheckpoint({
        now: () => (clock += 2),
        yieldNow: () => {
          yields += 1;
          return Promise.resolve();
        },
      }),
    );
    expect(yields).toBeGreaterThan(10);
  });
});
