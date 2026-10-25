import { describe, expect, it } from 'vitest';
import { isCountryCode, type CountryCode } from '@/src/shared/country.ts';
import type { EntityType } from '@/src/shared/entities.ts';
import { detectRules } from '@/src/core/detect/rules/detector.ts';
import { COUNTRY_PACKS } from '@/src/core/detect/rules/packs/index.ts';
import prompts from '../../../../fixtures/rules/prompts.json';
import negatives from '../../../../fixtures/rules/negatives.json';
import { SECRET_TOKENS } from './secret-tokens.ts';

const P0_TYPES = new Set<EntityType>([
  'EMAIL',
  'PHONE',
  'CARD',
  'BANK',
  'SECRET',
  'NATIONAL_ID',
]);

/** Replaces {{NAME}} with the token built at run time. */
function resolveTokens(text: string): string {
  return text.replace(/\{\{([A-Z_]+)\}\}/gu, (_, name: string) => {
    const token = SECRET_TOKENS[name];
    if (token === undefined) throw new Error(`unknown token ${name}`);
    return token;
  });
}

function regions(codes: readonly string[]): CountryCode[] {
  return codes.filter(isCountryCode);
}

describe('positive fixtures', () => {
  it.each(prompts.prompts)('$name', async ({ text, homeRegions, expected }) => {
    const input = resolveTokens(text);
    const detections = await detectRules(input, {
      homeRegions: regions(homeRegions),
      entityTypes: P0_TYPES,
      packs: COUNTRY_PACKS,
      exclude: [],
    });
    expect(
      detections.map((detection) => ({
        type: detection.type,
        value: detection.value,
        status: detection.status,
        ...('country' in
        (expected.find((e) => resolveTokens(e.value) === detection.value) ?? {})
          ? { country: detection.country }
          : {}),
      })),
    ).toEqual(
      expected.map((item) => ({ ...item, value: resolveTokens(item.value) })),
    );
    // Every span points into the prompt exactly as written.
    for (const detection of detections) {
      expect(input.slice(detection.start, detection.end)).toBe(detection.value);
      expect(detection.source).toBe('rule');
    }
  });
});

describe('negative fixtures', () => {
  it.each(negatives.texts)('finds nothing in: %s', async (text) => {
    for (const homeRegions of [
      [],
      ['US'],
      ['IN', 'GB'],
      ['DE', 'FR', 'BR'],
      ['IN'],
      ['CN'],
      ['SG'],
      ['ZA'],
    ] as const) {
      const detections = await detectRules(text, {
        homeRegions: regions(homeRegions),
        entityTypes: P0_TYPES,
        packs: COUNTRY_PACKS,
        exclude: [],
      });
      expect(detections.map((d) => [d.type, d.value, d.status])).toEqual([]);
    }
  });
});
