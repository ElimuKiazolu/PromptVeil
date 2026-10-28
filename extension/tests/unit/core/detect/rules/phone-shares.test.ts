import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CountryCode } from '@/src/shared/country.ts';
import type { EntityType } from '@/src/shared/entities.ts';
import { detectRules } from '@/src/core/detect/rules/detector.ts';
import type { CountryPack } from '@/src/core/detect/rules/packs/index.ts';
import { finding, type Rule } from '@/src/core/detect/rules/types.ts';
import type { Span } from '@/src/core/detect/text.ts';
import { validatePhone } from '@/src/core/detect/validators/phone.ts';
import {
  PERMISSIVE_CELLS,
  PHONE_SHARES_LENGTHS,
  PHONE_SHARES_LIBRARY_VERSION,
  PHONE_SHARES_SAMPLES,
  PHONE_VALID_COUNTS,
} from '@/src/core/detect/validators/phone-shares.generated.ts';
import { isPermissivePhoneCell } from '@/src/core/detect/validators/phone-shares.ts';

/** 99 % Wilson score lower bound (same formula as the generator). */
function wilsonLower(valid: number, samples: number): number {
  const z = 2.5758;
  const p = valid / samples;
  const z2 = z * z;
  const centre = p + z2 / (2 * samples);
  const margin =
    z * Math.sqrt((p * (1 - p)) / samples + z2 / (4 * samples * samples));
  return (centre - margin) / (1 + z2 / samples);
}

describe('phone random-share table', () => {
  it('was generated for the installed libphonenumber-js (regenerate after upgrading)', () => {
    const installed: unknown = JSON.parse(
      readFileSync(
        resolve('node_modules/libphonenumber-js/package.json'),
        'utf8',
      ),
    );
    expect(installed).toMatchObject({ version: PHONE_SHARES_LIBRARY_VERSION });
  });

  it('stores a class for every cell that matches its counts (99 % lower bound above 50 %)', () => {
    const derived: string[] = [];
    for (const [region, counts] of Object.entries(PHONE_VALID_COUNTS)) {
      expect(counts).toHaveLength(PHONE_SHARES_LENGTHS.length);
      counts.forEach((valid, i) => {
        if (wilsonLower(valid, PHONE_SHARES_SAMPLES) > 0.5) {
          derived.push(`${region}@${String(PHONE_SHARES_LENGTHS[i])}`);
        }
      });
    }
    expect([...PERMISSIVE_CELLS].sort()).toEqual(derived.sort());
  });

  it('classes Germany permissive at every length and the NANP/GB not at all', () => {
    for (const length of PHONE_SHARES_LENGTHS) {
      expect(isPermissivePhoneCell('DE', length)).toBe(true);
      expect(isPermissivePhoneCell('US', length)).toBe(false);
      expect(isPermissivePhoneCell('CA', length)).toBe(false);
      expect(isPermissivePhoneCell('GB', length)).toBe(false);
    }
  });
});

/** Fixed linear congruential sequence: the same numbers on every run. */
function seeded(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };
}

/** A digit run of `length` that is a valid national number in `region` (in memory). */
function homeNumber(region: CountryCode, length: number, seed: number): string {
  const next = seeded(seed);
  for (let tries = 0; tries < 50_000; tries += 1) {
    let digits = '';
    for (let k = 0; k < length; k += 1)
      digits += Math.floor(next() * 10).toString();
    const phone = validatePhone(digits, [region]);
    if (phone.valid && phone.fromHomeRegions) return digits;
  }
  throw new Error(`no ${region} number of ${String(length)} digits`);
}

/**
 * A test-only checksum reading of exactly `value` (an ID whose check passed),
 * with no context word, so only the permissive-cell rule can decide.
 */
function checksumPackFor(value: string): CountryPack {
  const rule: Rule = {
    id: 'aq.test-checksum',
    type: 'NATIONAL_ID',
    subtype: 'CA_SIN',
    country: 'AQ',
    *find(text): Generator<Span> {
      const at = text.indexOf(value);
      if (at !== -1) yield { start: at, end: at + value.length };
    },
    validate: () => finding(rule, 'checksum'),
    context: null,
    contextRequired: false,
    negativeContext: [],
    confidence: { validated: 1, context: 1, none: 1 },
  };
  return { country: 'AQ', rules: [rule], standIns: {} };
}

const TYPES = new Set<EntityType>(['PHONE', 'NATIONAL_ID']);

async function winner(region: CountryCode, length: number, seed: number) {
  const value = homeNumber(region, length, seed);
  const [detection] = await detectRules(`Number: ${value}`, {
    homeRegions: [region],
    entityTypes: TYPES,
    packs: [checksumPackFor(value)],
    exclude: [],
  });
  return detection?.type;
}

describe('a no-context checksum reading vs a no-context home phone reading', () => {
  it.each([
    ['DE', 11],
    ['FI', 9],
    ['SE', 9],
    ['PL', 9],
    ['DK', 8],
    ['JP', 9],
  ] as const)(
    'home %s, %i digits (permissive): the checksum reading wins',
    async (region, length) => {
      expect(isPermissivePhoneCell(region, length)).toBe(true);
      expect(await winner(region, length, 900 + length)).toBe('NATIONAL_ID');
    },
  );

  it.each([
    // Not permissive (35.7 %): home prior holds.
    ['US', 10],
    // Near the line (99 % interval contains 50 %): home prior holds.
    ['NO', 8],
  ] as const)(
    'home %s, %i digits: the home phone reading wins',
    async (region, length) => {
      expect(isPermissivePhoneCell(region, length)).toBe(false);
      expect(await winner(region, length, 950 + length)).toBe('PHONE');
    },
  );
});
