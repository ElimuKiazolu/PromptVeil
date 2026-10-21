import { describe, expect, it } from 'vitest';
import type { CountryCode } from '@/src/shared/country.ts';
import type { EntityType } from '@/src/shared/entities.ts';
import { isValidLuhn } from '@/src/core/detect/checksum.ts';
import { activeRules, detectRules } from '@/src/core/detect/rules/detector.ts';
import {
  assertValidPack,
  enabledPacks,
  type CountryPack,
} from '@/src/core/detect/rules/packs/index.ts';
import {
  INVALID,
  finding,
  type Rule,
  type Strength,
} from '@/src/core/detect/rules/types.ts';
import type { Span } from '@/src/core/detect/text.ts';
import { SECRET_TOKENS } from './secret-tokens.ts';

const ALL_P0 = new Set<EntityType>([
  'EMAIL',
  'PHONE',
  'CARD',
  'BANK',
  'SECRET',
  'NATIONAL_ID',
]);

function options(
  overrides: Partial<Parameters<typeof detectRules>[1]> = {},
): Parameters<typeof detectRules>[1] {
  return {
    homeRegions: ['US'],
    entityTypes: ALL_P0,
    packs: [],
    exclude: [],
    ...overrides,
  };
}

/** Nine-digit runs at word boundaries (the shape several countries' IDs share). */
function* nineDigitRuns(text: string): Generator<Span> {
  for (const match of text.matchAll(/(?<!\d)\d{9}(?!\d)/gu)) {
    yield { start: match.index, end: match.index + 9 };
  }
}

/*
 * Test-only packs for two territories without national ID packs (AQ, BV).
 * The subtype union is closed, so they borrow existing subtypes; they are
 * never registered outside these tests.
 */
const AQ_RULE: Rule = {
  id: 'aq.test-id',
  type: 'NATIONAL_ID',
  subtype: 'US_SSN',
  country: 'AQ',
  find: nineDigitRuns,
  validate: () => finding(AQ_RULE, 'structural'),
  context: { words: ['aq id'], before: 24, after: 0 },
  contextRequired: false,
  negativeContext: [],
  confidence: { validated: 1, context: 0.9, none: 0.7 },
};

const BV_RULE: Rule = {
  id: 'bv.test-id',
  type: 'NATIONAL_ID',
  subtype: 'CA_SIN',
  country: 'BV',
  find: nineDigitRuns,
  validate: (value) =>
    finding(BV_RULE, isValidLuhn(value) ? 'checksum' : 'structural'),
  context: { words: ['bv number'], before: 24, after: 0 },
  contextRequired: false,
  negativeContext: [],
  confidence: { validated: 1, context: 0.9, none: 0.7 },
};

const AQ_PACK: CountryPack = {
  country: 'AQ',
  rules: [AQ_RULE],
  standIns: { US_SSN: { formats: ['#########'], checksum: null } },
};

const BV_PACK: CountryPack = {
  country: 'BV',
  rules: [BV_RULE],
  standIns: { CA_SIN: { formats: ['#########'], checksum: 'luhn' } },
};

const IDS_ONLY = new Set<EntityType>(['NATIONAL_ID']);

describe('country pack template', () => {
  it('accepts well-formed packs and rejects rules that do not belong', () => {
    expect(() => {
      assertValidPack(AQ_PACK);
    }).not.toThrow();
    expect(() => {
      assertValidPack({ ...AQ_PACK, country: 'BV' });
    }).toThrow('another country');
    expect(() => {
      assertValidPack({ ...AQ_PACK, standIns: {} });
    }).toThrow('no stand-in spec');
    expect(() => {
      assertValidPack({ ...AQ_PACK, rules: [AQ_RULE, AQ_RULE] });
    }).toThrow('duplicate rule id');
  });

  it('switches packs off per country; a missing entry counts as on', () => {
    const packs = [AQ_PACK, BV_PACK];
    expect(enabledPacks(packs, {})).toEqual(packs);
    expect(enabledPacks(packs, { BV: false })).toEqual([AQ_PACK]);
    expect(enabledPacks(packs, { AQ: true, BV: true })).toEqual(packs);
  });

  it('runs pack rules only for enabled entity types', () => {
    const rules = activeRules(
      options({ packs: [AQ_PACK], entityTypes: IDS_ONLY }),
    );
    expect(rules.map((rule) => rule.id)).toEqual(['aq.test-id']);
  });
});

describe('ambiguity between packs (TR-R3)', () => {
  // 046454286 passes Luhn (fixture CA SIN); 123456789 does not.
  const LUHN = '046454286';
  const NO_LUHN = '123456789';

  it('prefers the reading with a checksum', async () => {
    const [detection] = await detectRules(
      `id ${LUHN}`,
      options({ packs: [AQ_PACK, BV_PACK], entityTypes: IDS_ONLY }),
    );
    expect(detection).toMatchObject({
      country: 'BV',
      subtype: 'CA_SIN',
      status: 'confirmed',
      alternatives: [{ subtype: 'US_SSN', country: 'AQ' }],
    });
  });

  it('prefers a reading with its context word over a stronger checksum', async () => {
    const [detection] = await detectRules(
      `my AQ ID: ${LUHN}`,
      options({ packs: [AQ_PACK, BV_PACK], entityTypes: IDS_ONLY }),
    );
    expect(detection).toMatchObject({
      country: 'AQ',
      status: 'confirmed',
      confidence: 0.9,
      alternatives: [{ country: 'BV' }],
    });
  });

  it('prefers a home region next', async () => {
    const [detection] = await detectRules(
      `id ${NO_LUHN}`,
      options({
        homeRegions: ['BV'],
        packs: [AQ_PACK, BV_PACK],
        entityTypes: IDS_ONLY,
      }),
    );
    expect(detection).toMatchObject({ country: 'BV', status: 'confirmed' });
  });

  it('reports "possible" when still ambiguous and unchecksummed', async () => {
    const [detection] = await detectRules(
      `id ${NO_LUHN}`,
      options({ packs: [AQ_PACK, BV_PACK], entityTypes: IDS_ONLY }),
    );
    expect(detection).toMatchObject({
      country: 'AQ',
      status: 'possible',
      confidence: 0.5,
      alternatives: [{ country: 'BV', subtype: 'CA_SIN' }],
    });
  });

  it('is confirmed with one pack switched off', async () => {
    const packs = enabledPacks([AQ_PACK, BV_PACK], { BV: false });
    const [detection] = await detectRules(
      `id ${NO_LUHN}`,
      options({ packs, entityTypes: IDS_ONLY }),
    );
    expect(detection).toMatchObject({
      country: 'AQ',
      status: 'confirmed',
      alternatives: [],
    });
  });
});

/** A rule reporting fixed spans with a fixed verdict. */
function fixedRule(
  id: string,
  type: EntityType,
  spans: readonly [number, number][],
  strength: Strength,
  extra: { possible?: boolean; context?: boolean } = {},
): Rule {
  const rule: Rule = {
    id,
    type,
    subtype: null,
    country: 'AQ',
    find: () => spans.map(([start, end]) => ({ start, end })),
    validate: () =>
      finding(rule, strength, { possible: extra.possible ?? false }),
    // The word "ctx" at the start of the text is this rule's context word.
    context:
      extra.context === true ? { words: ['ctx'], before: 100, after: 0 } : null,
    contextRequired: false,
    negativeContext: [],
    confidence: { validated: 1, context: 0.9, none: 0.8 },
  };
  return rule;
}

async function select(text: string, rules: Rule[]): Promise<string[]> {
  const pack: CountryPack = {
    country: 'AQ',
    rules,
    standIns: {},
  };
  const detections = await detectRules(
    text,
    options({ packs: [pack], entityTypes: new Set(rules.map((r) => r.type)) }),
  );
  return detections.map(
    (detection) =>
      `${detection.type}:${text.slice(detection.start, detection.end)}`,
  );
}

describe('overlap resolution order', () => {
  // Letters only, so no global rule finds anything here.
  const text = 'ctx abcdefghij klmnop';

  it('takes confirmed before possible', async () => {
    expect(
      await select(text, [
        fixedRule('a', 'SECRET', [[4, 14]], 'checksum', { possible: true }),
        fixedRule('b', 'PHONE', [[4, 10]], 'none'),
      ]),
    ).toEqual(['PHONE:abcdef']);
  });

  it('then stronger validation', async () => {
    expect(
      await select(text, [
        fixedRule('a', 'PHONE', [[4, 14]], 'structural'),
        fixedRule('b', 'CARD', [[6, 12]], 'checksum'),
      ]),
    ).toEqual(['CARD:cdefgh']);
  });

  it('then a context word', async () => {
    expect(
      await select(text, [
        fixedRule('a', 'SECRET', [[4, 14]], 'structural'),
        fixedRule('b', 'PHONE', [[6, 12]], 'structural', { context: true }),
      ]),
    ).toEqual(['PHONE:cdefgh']);
  });

  it('then the longer span', async () => {
    expect(
      await select(text, [
        fixedRule('a', 'SECRET', [[6, 12]], 'structural'),
        fixedRule('b', 'PHONE', [[4, 14]], 'structural'),
      ]),
    ).toEqual(['PHONE:abcdefghij']);
  });

  it('then the type order: SECRET, BANK, CARD, NATIONAL_ID, EMAIL, PHONE, others', async () => {
    const order: EntityType[] = [
      'SECRET',
      'BANK',
      'CARD',
      'NATIONAL_ID',
      'EMAIL',
      'PHONE',
      'IP',
    ];
    for (let i = 0; i + 1 < order.length; i += 1) {
      const [first = 'SECRET', second = 'SECRET'] = order.slice(i, i + 2);
      // The later type is listed first, so rule order cannot decide.
      expect(
        await select(text, [
          fixedRule('a', second, [[4, 10]], 'structural'),
          fixedRule('b', first, [[5, 11]], 'structural'),
        ]),
      ).toEqual([`${first}:bcdefg`]);
    }
  });

  it('then the earlier start, then rule order', async () => {
    expect(
      await select(text, [
        fixedRule('a', 'PHONE', [[6, 12]], 'structural'),
        fixedRule('b', 'PHONE', [[4, 10]], 'structural'),
      ]),
    ).toEqual(['PHONE:abcdef']);
    expect(
      await select(text, [
        fixedRule('a', 'PHONE', [[4, 10]], 'structural'),
        fixedRule('b', 'CARD', [[4, 10]], 'structural'),
      ]),
    ).toEqual(['CARD:abcdef']);
  });

  it('keeps neighbours that touch without a separator', async () => {
    expect(
      await select(text, [
        fixedRule('a', 'PHONE', [[4, 9]], 'structural'),
        fixedRule('b', 'CARD', [[9, 14]], 'structural'),
        fixedRule('c', 'SECRET', [[15, 21]], 'structural'),
      ]),
    ).toEqual(['PHONE:abcde', 'CARD:fghij', 'SECRET:klmnop']);
  });

  it('drops invalid candidates and returns results sorted by position', async () => {
    const invalid: Rule = {
      ...fixedRule('x', 'SECRET', [[0, 21]], 'checksum'),
      validate: () => INVALID,
    };
    expect(
      await select(text, [
        invalid,
        fixedRule('a', 'CARD', [[15, 21]], 'structural'),
        fixedRule('b', 'PHONE', [[4, 14]], 'structural'),
      ]),
    ).toEqual(['PHONE:abcdefghij', 'CARD:klmnop']);
  });
});

describe('overlaps between real rules', () => {
  it('a 15-digit Amex number is a card, not a phone number', async () => {
    const detections = await detectRules(
      'Amex 3782 822463 10005 ok',
      options(),
    );
    expect(detections.map((d) => [d.type, d.value])).toEqual([
      ['CARD', '3782 822463 10005'],
    ]);
  });

  it('a password in a URL is a secret, not part of an email address', async () => {
    const detections = await detectRules(
      'see https://bob:Tr0ub4dor3x@db.example.com/x',
      options(),
    );
    expect(detections.map((d) => [d.type, d.value])).toEqual([
      ['SECRET', 'Tr0ub4dor3x'],
    ]);
  });

  it('an email address in a query string is an email', async () => {
    const detections = await detectRules(
      'https://example.com/u?email=dana@example.org&next=%2F',
      options(),
    );
    expect(detections.map((d) => [d.type, d.value])).toEqual([
      ['EMAIL', 'dana@example.org'],
    ]);
  });

  it('a Slack token with digit runs is one secret', async () => {
    const token = SECRET_TOKENS.SLACK_TOKEN ?? '';
    const detections = await detectRules(`token ${token} here`, options());
    expect(detections.map((d) => [d.type, d.value])).toEqual([
      ['SECRET', token],
    ]);
  });

  it('an IBAN is never split into a card number', async () => {
    const detections = await detectRules(
      'card IBAN GB82 WEST 1234 5698 7654 32',
      options({ homeRegions: ['GB'] }),
    );
    expect(detections.map((d) => [d.type, d.value])).toEqual([
      ['BANK', 'GB82 WEST 1234 5698 7654 32'],
    ]);
  });
});

describe('detectRules options', () => {
  it('runs only the enabled entity types', async () => {
    const text = 'dana@example.com +44 20 7946 0018';
    const emails = await detectRules(
      text,
      options({ entityTypes: new Set<EntityType>(['EMAIL']) }),
    );
    expect(emails.map((d) => d.type)).toEqual(['EMAIL']);
  });

  it('never detects inside an excluded span (an issued stand-in)', async () => {
    const text = 'a@example.com and b@example.com';
    const detections = await detectRules(
      text,
      options({ exclude: [{ start: 14, end: 31 }] }),
    );
    expect(detections.map((d) => d.value)).toEqual(['a@example.com']);
    // Partial overlap excludes too.
    const partial = await detectRules(
      text,
      options({ exclude: [{ start: 20, end: 21 }] }),
    );
    expect(partial.map((d) => d.value)).toEqual(['a@example.com']);
  });

  it('maps spans back to the original text across normalisation', async () => {
    const text =
      'Mail ｄａｎａ＠ｅｘａｍｐｌｅ．ｃｏｍ, card 4242\u00A04242\u00A04242\u00A04242';
    const detections = await detectRules(text, options());
    for (const detection of detections) {
      expect(text.slice(detection.start, detection.end)).toBe(detection.value);
    }
    expect(detections.map((d) => d.type)).toEqual(['EMAIL', 'CARD']);
  });

  it('reports a foreign phone number valid in several regions as confirmed, with alternatives', async () => {
    // libphonenumber's example French mobile number, written nationally.
    const [detection] = await detectRules('call 06 12 34 56 78', options());
    expect(detection).toMatchObject({ type: 'PHONE', status: 'confirmed' });
    expect(detection?.alternatives.length).toBeGreaterThan(0);
  });

  it('drops a phone-shaped candidate with negative context, unless a phone word is near', async () => {
    const regions: CountryCode[] = ['IN'];
    expect(
      await detectRules(
        'order no. 8123456789',
        options({ homeRegions: regions }),
      ),
    ).toEqual([]);
    const [detection] = await detectRules(
      'mobile, order no. 8123456789',
      options({ homeRegions: regions }),
    );
    expect(detection).toMatchObject({
      type: 'PHONE',
      status: 'confirmed',
      country: 'IN',
    });
  });

  it('marks a UnionPay number failing Luhn as possible, and only with card context', async () => {
    // 6212345678901234567 fails Luhn.
    expect(await detectRules('ref 6212345678901234567', options())).toEqual([]);
    const [detection] = await detectRules(
      '银联卡号 6212345678901234567',
      options(),
    );
    expect(detection).toMatchObject({ type: 'CARD', status: 'possible' });
  });
});

describe('linear time on adversarial input', () => {
  const LONG = 100_000;
  const inputs: Record<string, string> = {
    digits: '1'.repeat(LONG),
    'spaced digits': '1 '.repeat(LONG / 2),
    'dotted digits': '1.'.repeat(LONG / 2),
    'hyphenated groups': '1234-'.repeat(LONG / 5),
    brackets: '(1'.repeat(LONG / 2),
    'at signs': 'a@'.repeat(LONG / 2),
    'IBAN starts': 'GB29 '.repeat(LONG / 5),
    'token characters': 'aB3-'.repeat(LONG / 4),
    padding: 'a='.repeat(LONG / 2),
    assignments: 'password='.repeat(LONG / 9),
    'quoted assignment': `token: "${'x'.repeat(LONG)}`,
    'PEM headers': '-----BEGIN '.repeat(LONG / 11),
    'Basic schemes': `Basic ${'A'.repeat(LONG)}`,
    'URL userinfo': `https://${'a:'.repeat(LONG / 2)}`,
    'curl options': ' -u a:'.repeat(LONG / 6),
    'context words': 'token '.repeat(LONG / 6),
    'zero-width digits': '1\u200B'.repeat(LONG / 2),
  };

  it.each(Object.entries(inputs))('%s', async (_, text) => {
    const started = performance.now();
    await detectRules(text, options({ homeRegions: [] }));
    // Generous for a shared CI runner; a quadratic scan takes minutes.
    expect(performance.now() - started).toBeLessThan(5000);
  });
});
