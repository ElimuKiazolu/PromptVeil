import { describe, expect, it } from 'vitest';
import { COUNTRY_PACKS } from '@/src/core/detect/rules/packs/index.ts';
import { detectRules } from '@/src/core/detect/rules/detector.ts';
import { TEST_CARDS } from '@/src/core/detect/validators/reserved-values.ts';
import { CARD_RULE } from '@/src/core/detect/rules/card.ts';
import {
  containsWord,
  hasContextWord,
} from '@/src/core/detect/rules/context.ts';
import { EMAIL_RULE } from '@/src/core/detect/rules/email.ts';
import { findIbanCandidates } from '@/src/core/detect/rules/iban.ts';
import { blockingCheckpoint } from '@/src/core/detect/schedule.ts';
import type { Rule } from '@/src/core/detect/rules/types.ts';

const spans = (rule: Pick<Rule, 'find'>, text: string): string[] =>
  [...rule.find(text)].map(({ start, end }) => text.slice(start, end));

const env = (hasContext = false) => ({
  homeRegions: [],
  preferredRegions: [],
  hasContext,
  checkpoint: blockingCheckpoint(),
});

describe('context words', () => {
  it('match whole Latin words and phrases, in any case', () => {
    expect(containsWord('call me', 'call')).toBe(true);
    expect(containsWord('recall me', 'call')).toBe(false);
    expect(containsWord('the hotel', 'tel')).toBe(false);
    expect(containsWord('your api key', 'api key')).toBe(true);
  });

  it('match other scripts and symbols anywhere', () => {
    expect(containsWord('我的银联卡号是', '银联')).toBe(true);
    expect(containsWord('order#12', '#')).toBe(true);
  });

  it('read underscores, hyphens and camelCase as spaces', () => {
    const text = 'const apiKey = X; x-api-key: Y; API_KEY=Z';
    for (const at of [
      text.indexOf('X'),
      text.indexOf('Y'),
      text.indexOf('Z'),
    ]) {
      expect(
        hasContextWord(
          text,
          { start: at, end: at + 1 },
          {
            words: ['api key'],
            before: 10,
            after: 0,
          },
        ),
      ).toBe(true);
    }
  });

  it('look only inside the window, on each side separately', () => {
    const text = 'phone ........................ 123';
    const span = { start: text.indexOf('123'), end: text.length };
    expect(
      hasContextWord(text, span, { words: ['phone'], before: 10, after: 0 }),
    ).toBe(false);
    expect(
      hasContextWord(text, span, { words: ['phone'], before: 40, after: 0 }),
    ).toBe(true);
    expect(
      hasContextWord(
        '123 seconds',
        { start: 0, end: 3 },
        { words: ['seconds'], before: 0, after: 10 },
      ),
    ).toBe(true);
  });
});

describe('EMAIL_RULE', () => {
  it('finds addresses and confirms them', () => {
    expect(spans(EMAIL_RULE, 'to dana@example.com, ops@example.org.')).toEqual([
      'dana@example.com',
      'ops@example.org',
    ]);
    expect(EMAIL_RULE.validate('dana@example.com', env())).toMatchObject({
      valid: true,
      strength: 'structural',
    });
  });
});

describe('CARD_RULE', () => {
  it('finds 13–19 digit runs not glued to other numbers', () => {
    expect(spans(CARD_RULE, 'card 4242 4242 4242 4242 ok')).toEqual([
      '4242 4242 4242 4242',
    ]);
    expect(spans(CARD_RULE, 'card 4242-4242-4242-4242.')).toEqual([
      '4242-4242-4242-4242',
    ]);
    // Part of a longer number, a decimal or a word.
    expect(spans(CARD_RULE, '4242 4242 4242 4242 4242')).toEqual([]);
    expect(spans(CARD_RULE, '0.4242424242424242')).toEqual([]);
    expect(spans(CARD_RULE, 'x4242424242424242')).toEqual([]);
    expect(spans(CARD_RULE, '4242424242424242,5')).toEqual([]);
  });

  it('confirms Luhn-valid branded numbers', () => {
    // Braintree's published Visa test number.
    expect(CARD_RULE.validate('4111 1111 1111 1111', env())).toMatchObject({
      valid: true,
      strength: 'checksum',
      possible: false,
    });
    expect(CARD_RULE.validate('4111 1111 1111 1112', env(true))).toEqual({
      valid: false,
    });
  });

  it('marks the published test card numbers stand-ins use as reserved', async () => {
    for (const number of Object.values(TEST_CARDS).flat()) {
      expect(CARD_RULE.validate(number, env(true)), number).toMatchObject({
        valid: true,
        reserved: true,
      });
      // Reserved values are not reported, nor is another reading of them.
      const found = await detectRules(`card ${number} and a 16 digit VID`, {
        homeRegions: ['IN'],
        entityTypes: new Set(['CARD', 'NATIONAL_ID', 'PHONE']),
        packs: COUNTRY_PACKS,
        exclude: [],
      });
      expect(found, number).toEqual([]);
    }
    // Only the exact numbers: the same prefix with other digits is a card.
    expect(CARD_RULE.validate('4242 4242 4242 4226', env())).toMatchObject({
      valid: true,
      reserved: false,
    });
  });

  it('reports a UnionPay number failing Luhn only with context, as possible', () => {
    expect(CARD_RULE.validate('6212345678901234567', env())).toEqual({
      valid: false,
    });
    expect(
      CARD_RULE.validate('6212 3456 7890 1234 567', env(true)),
    ).toMatchObject({
      valid: true,
      strength: 'none',
      possible: true,
    });
    // Not UnionPay: no 62 prefix (a Stripe test card with its last digit changed).
    expect(CARD_RULE.validate('5555555555554445', env(true))).toEqual({
      valid: false,
    });
  });
});

describe('findIbanCandidates', () => {
  it('reads exactly the registry length, with or without groups', () => {
    const text = 'IBAN GB29 NWBK 6016 1331 9268 19 and then 1234 more';
    expect(spans({ find: findIbanCandidates }, text)).toEqual([
      'GB29 NWBK 6016 1331 9268 19',
    ]);
    expect(spans({ find: findIbanCandidates }, 'NL91ABNA0417164300.')).toEqual([
      'NL91ABNA0417164300',
    ]);
  });

  it('starts only at a word boundary or right after another IBAN', () => {
    expect(
      spans({ find: findIbanCandidates }, 'XGB29NWBK60161331926819'),
    ).toEqual([]);
    expect(
      spans(
        { find: findIbanCandidates },
        'GB29NWBK60161331926819DE89370400440532013000',
      ),
    ).toEqual(['GB29NWBK60161331926819', 'DE89370400440532013000']);
  });

  it('skips countries without IBANs and runs that are too short', () => {
    expect(spans({ find: findIbanCandidates }, 'US12 3456 7890 1234')).toEqual(
      [],
    );
    expect(spans({ find: findIbanCandidates }, 'GB29 NWBK 6016')).toEqual([]);
  });
});
