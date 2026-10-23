import { describe, expect, it } from 'vitest';
import { detectRules } from '@/src/core/detect/rules/detector.ts';
import {
  PHONE_RULE,
  findPhoneCandidates,
  isTimestamp,
} from '@/src/core/detect/rules/phone.ts';
import { blockingCheckpoint } from '@/src/core/detect/schedule.ts';
import type { CountryCode } from '@/src/shared/country.ts';

const candidates = (text: string): string[] =>
  [...findPhoneCandidates(text)].map(({ start, end }) =>
    text.slice(start, end),
  );

const env = (homeRegions: CountryCode[], hasContext = false) => ({
  homeRegions,
  preferredRegions: [],
  hasContext,
  checkpoint: blockingCheckpoint(),
});

describe('findPhoneCandidates: phone shapes', () => {
  it.each([
    '+44 20 7946 0018',
    '+44 (0)20 7946 0018',
    '(202) 555-0143',
    '202.555.0143',
    '020 7946 0018',
    '06 12 34 56 78',
    '030/123456',
    '81234 56789',
    '8123456789',
    '+12025550143',
  ])('passes %s', (number) => {
    expect(candidates(`call ${number} today`)).toEqual([number]);
  });

  it('stops before a separator that no digit group follows', () => {
    expect(candidates('on 020 7946 0018 (UK).')).toEqual(['020 7946 0018']);
    expect(candidates('on 020 7946 0018.')).toEqual(['020 7946 0018']);
  });
});

describe('findPhoneCandidates: shapes that are something else', () => {
  it.each([
    ['ISO date', '2024-10-19'],
    ['day-first date', '19/10/2024'],
    ['dotted date', '19.10.2024'],
    ['compact date', '20241019'],
    ['year range', '1990-2024'],
    ['decimal', '3.14159265'],
    ['version', '10.0.19045.3693'],
    ['IPv4 address', '192.168.100.200'],
    ['ISBN-13', '978-3-16-148410-0'],
    ['ISBN-10', '0-306-40615-2'],
    ['bare ISBN-13', '9780306406157'],
    ['list of small numbers', '4 8 15 16 23 42'],
    ['thousands grouping', '12 345 678'],
    ['dotted thousands', '1.234.567'],
    ['too short', '55-0143'],
    ['too long', '1234567890123456'],
  ])('rejects a %s (%s)', (_, value) => {
    expect(candidates(`x ${value} y`)).toEqual([]);
  });

  it.each([
    ['glued to letters', 'abc12345678'],
    ['glued to letters after', '12345678abc'],
    ['after a currency sign', '$12345678'],
    ['after a currency sign and space', '€ 12 345 678 9'],
    ['before a currency sign', '12345678 €'],
    ['a percentage', '12345678%'],
    ['a decimal tail', '1234567.89'],
    ['a time', '12345678:30'],
    ['after #', '#12345678'],
    ['the result of a sum', '= 7006652'],
    ['after an operator', '2 + 1234567'],
    ['inside a UUID', '550e8400-e29b-41d4-a716-446655440000'],
    ['a local part', '12345678@example.com'],
  ])('rejects a number %s', (_, value) => {
    expect(candidates(value)).toEqual([]);
  });

  it('resumes after a rejected token', () => {
    expect(candidates('v1.2.3 then 020 7946 0018')).toEqual(['020 7946 0018']);
  });
});

describe('PHONE_RULE.validate', () => {
  it('confirms a number valid in a home region', async () => {
    await expect(
      PHONE_RULE.validate('020 7946 0018', env(['GB'])),
    ).resolves.toMatchObject({
      valid: true,
      country: 'GB',
      possible: false,
      alternatives: [],
    });
  });

  it('confirms an international number', async () => {
    await expect(
      PHONE_RULE.validate('+44 20 7946 0018', env(['US'])),
    ).resolves.toMatchObject({
      valid: true,
      country: 'GB',
      possible: false,
    });
  });

  it('confirms a grouped number valid only elsewhere, listing the other regions', async () => {
    // libphonenumber's example Indian mobile number.
    const verdict = await PHONE_RULE.validate('81234 56789', env(['GB']));
    if (!verdict.valid) throw new Error('expected a valid number');
    expect(verdict.possible).toBe(false);
    const countries = [
      verdict.country,
      ...verdict.alternatives.map((a) => a.country),
    ];
    expect(countries).toContain('IN');
    expect(countries.length).toBeGreaterThan(1);
  });

  it('marks a bare run valid only elsewhere as possible, unless a phone word is near', async () => {
    await expect(
      PHONE_RULE.validate('8123456789', env(['GB'])),
    ).resolves.toMatchObject({
      valid: true,
      possible: true,
    });
    await expect(
      PHONE_RULE.validate('8123456789', env(['GB'], true)),
    ).resolves.toMatchObject({
      valid: true,
      possible: false,
    });
  });

  it('rejects numbers valid nowhere', async () => {
    await expect(
      PHONE_RULE.validate('000 0000 0000', env(['GB'])),
    ).resolves.toEqual({
      valid: false,
    });
  });
});

describe('ranking of foreign readings', () => {
  it('ranks the region that writes the number this way first: a French mobile with home US is FR', async () => {
    // libphonenumber's example French mobile number, written the French way.
    const verdict = await PHONE_RULE.validate('06 12 34 56 78', env(['US']));
    if (!verdict.valid) throw new Error('expected a valid number');
    expect(verdict.country).toBe('FR');
    expect(verdict.alternatives.every((a) => a.type === 'PHONE')).toBe(true);
    expect(verdict.alternatives.map((a) => a.country)).toContain('AF');
  });

  it('ranks browser-language regions after home regions', async () => {
    const verdict = await PHONE_RULE.validate('06 12 34 56 78', {
      ...env(['US']),
      preferredRegions: ['AF'],
    });
    expect(verdict.valid && verdict.country).toBe('AF');
  });

  it('falls back to the main region, a known type, then the alphabet for bare runs', async () => {
    const first = await PHONE_RULE.validate('0612345678', env(['US']));
    const second = await PHONE_RULE.validate('0612345678', env(['US']));
    // Deterministic, and the same number in every position.
    expect(first).toEqual(second);
    if (!first.valid) throw new Error('expected a valid number');
    const countries = [
      first.country,
      ...first.alternatives.map((a) => a.country),
    ];
    expect(new Set(countries).size).toBe(countries.length);
  });
});

describe('timestamps are not phone numbers', () => {
  const detect = async (text: string) =>
    (
      await detectRules(text, {
        homeRegions: ['US'],
        entityTypes: new Set(['PHONE']),
        packs: [],
        exclude: [],
      })
    ).map((d) => d.value);

  it.each([
    '"created_at": 2015550143,',
    'updated_at=2015550143',
    'expires 2015550143',
    '{"iat": 2015550143, "exp": 2015550200}',
    'ts: 2015550143000',
    'f(2015550143)',
  ])(
    'skips a plausible Unix time in code or next to a time key: %s',
    async (text) => {
      expect(await detect(text)).toEqual([]);
    },
  );

  it('still finds the same digits with a phone word nearby', async () => {
    // 201 555 0143: NANP 555-01xx fictional number; as Unix seconds, 2033.
    expect(await detect('phone: 2015550143,')).toEqual(['2015550143']);
    expect(await detect('Call me at 2015550143')).toEqual(['2015550143']);
  });

  it('ignores runs outside 2000–2040 or of other lengths', () => {
    expect(isTimestamp('x: 9000000000', { start: 3, end: 13 })).toBe(false);
    expect(isTimestamp('x: 123456789', { start: 3, end: 12 })).toBe(false);
    expect(isTimestamp('x: 1700000000', { start: 3, end: 13 })).toBe(true);
    expect(isTimestamp('call 1700000000 now', { start: 5, end: 15 })).toBe(
      false,
    );
  });
});
