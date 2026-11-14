import { describe, expect, it } from 'vitest';
import { SECRET_TOKENS } from '../detect/rules/secret-tokens.ts';
import { chatgptNetRules } from '@/src/adapters/chatgpt.ts';
import { requestTexts } from '@/src/net/request.ts';
import {
  collectJsonStrings,
  decideRequest,
  parseJsonText,
  violatesTier1,
  violatesTier2,
  type NetKnowledge,
} from '@/src/core/net/checks.ts';
import { normaliseReal } from '@/src/core/detect/normal-form.ts';
import { netForms } from '@/src/core/net/forms.ts';
import { createFormHasher } from '@/src/core/net/hash.ts';
import { createRollingHash, rollingBase } from '@/src/core/net/rolling.ts';
import { isSpikeStandIn } from '@/src/core/spike-standin.ts';
import type { CountryCode } from '@/src/shared/country.ts';
import type { EntitySubtype, EntityType } from '@/src/shared/entities.ts';

const KEY = 'c3'.repeat(32);
/** An AWS-format key ID built at run time (no scanner-matching literal). */
const AWS_KEY = SECRET_TOKENS.AWS_ACCESS_KEY ?? '';
const matcher = {
  rolling: createRollingHash(rollingBase(KEY)),
  hash: createFormHasher(KEY),
};

interface Masked {
  type: EntityType;
  subtype?: EntitySubtype | null;
  country?: CountryCode | null;
  value: string;
}

/** The net's knowledge after the given values were masked in this tab. */
function knowledge(
  real: (string | Masked)[] = [],
  standIns: string[] = [],
): NetKnowledge {
  const rollingByLength = new Map<number, Set<number>>();
  const formHashes = new Set<string>();
  for (const entry of real) {
    const masked: Masked =
      typeof entry === 'string' ? { type: 'EMAIL', value: entry } : entry;
    const normalised = normaliseReal(
      masked.type,
      masked.subtype ?? null,
      masked.country ?? null,
      masked.value,
    );
    for (const form of netForms(masked.type, masked.value, normalised)) {
      const values = rollingByLength.get(form.length) ?? new Set<number>();
      values.add(matcher.rolling.of(form));
      rollingByLength.set(form.length, values);
      formHashes.add(matcher.hash(form));
    }
  }
  return {
    standIns: new Set(standIns),
    isStandIn: isSpikeStandIn,
    rollingByLength,
    formHashes,
    matcher,
  };
}

describe('collectJsonStrings and parseJsonText', () => {
  it('collects every string value and key, however deep', () => {
    const value = {
      a: 'one',
      list: ['two', { b: 'three', n: 4, t: true, z: null }],
    };
    expect(collectJsonStrings(value).sort()).toEqual(
      ['a', 'b', 'list', 'n', 'one', 't', 'three', 'two', 'z'].sort(),
    );
  });

  it('decodes JSON escapes when parsing', () => {
    const json = parseJsonText('{"x":"dana\\u0040example.com"}');
    expect(collectJsonStrings(json)).toContain('dana@example.com');
  });

  it('returns undefined for text that is not JSON', () => {
    expect(parseJsonText('plain text')).toBeUndefined();
    expect(parseJsonText('{not json')).toBeUndefined();
    expect(parseJsonText('  [1,2]')).toEqual([1, 2]);
  });

  it('stops at an unreasonable nesting depth', () => {
    let deep: unknown = 'bottom';
    for (let i = 0; i < 200; i += 1) deep = [deep];
    expect(collectJsonStrings(deep)).toEqual([]);
  });
});

describe('tier 1: message text', () => {
  it('blocks an email that is not a stand-in', () => {
    expect(violatesTier1(['write to dana@example.com'], knowledge())).toBe(
      true,
    );
  });

  it('allows stand-ins issued in this tab, in any case', () => {
    const k = knowledge([], ['ops-standin@example.org']);
    expect(violatesTier1(['to OPS-STANDIN@example.org'], k)).toBe(false);
  });

  it('allows stand-ins in the spike format from an earlier page load', () => {
    expect(
      violatesTier1(
        ['old standin.4@example.net and standin.2.ab12@example.net'],
        knowledge(),
      ),
    ).toBe(false);
  });

  it('allows text without emails', () => {
    expect(violatesTier1(['hello', ''], knowledge())).toBe(false);
  });
});

describe('tier 2: known real values anywhere', () => {
  it('blocks a request carrying a value masked in this tab', () => {
    expect(
      violatesTier2(
        ['{"q":"DANA@example.com"}'],
        knowledge(['dana@example.com']),
      ),
    ).toBe(true);
  });

  it('allows other emails, such as the account email in settings calls', () => {
    expect(
      violatesTier2(
        ['account: me@example.org'],
        knowledge(['dana@example.com']),
      ),
    ).toBe(false);
  });

  it('does nothing before any value is masked or without a key', () => {
    expect(violatesTier2(['dana@example.com'], knowledge())).toBe(false);
    expect(
      violatesTier2(['dana@example.com'], {
        ...knowledge(['dana@example.com']),
        matcher: null,
      }),
    ).toBe(false);
  });

  // Published example values (libphonenumber, HMRC tutorial NINO,
  // python-stdnum CPF, Braintree test card, SWIFT registry IBAN) and a
  // made-up AWS-shaped key.
  const VALUES: (Masked & { writings: string[] })[] = [
    {
      type: 'PHONE',
      country: 'GB',
      value: '07400 123456',
      writings: [
        'call 07400 123456',
        'call +44 7400 123456',
        'call 0044-7400-123-456',
        'call (07400)123456',
        '{"tel":"+447400123456"}',
      ],
    },
    {
      type: 'NATIONAL_ID',
      subtype: 'UK_NINO',
      country: 'GB',
      value: 'AB 12 34 56 C',
      writings: ['ni AB123456C', 'ni ab 12 34 56 c', 'ni AB-12-34-56-C'],
    },
    {
      type: 'NATIONAL_ID',
      subtype: 'BR_CPF',
      country: 'BR',
      value: '390.533.447-05',
      writings: ['cpf 39053344705', 'cpf 390 533 447 05'],
    },
    {
      type: 'CARD',
      value: '4111 1111 1111 1111',
      writings: ['card=4111111111111111', 'card 4111-1111-1111-1111'],
    },
    {
      type: 'BANK',
      subtype: 'IBAN',
      value: 'GB82 WEST 1234 5698 7654 32',
      writings: ['iban gb82west12345698765432', 'GB82-WEST-1234-5698-7654-32'],
    },
    {
      type: 'SECRET',
      value: AWS_KEY,
      writings: [
        `key=${AWS_KEY.toLowerCase()}`,
        (AWS_KEY.match(/.{4}/gu) ?? []).join(' '),
      ],
    },
  ];

  it.each(VALUES)(
    'blocks $type $value in any common writing',
    ({ writings, ...masked }) => {
      const k = knowledge([masked]);
      for (const writing of writings) {
        expect(violatesTier2([writing], k), writing).toBe(true);
      }
      // Other values of the same shape pass.
      expect(violatesTier2(['nothing masked here: 1234 5678'], k)).toBe(false);
    },
  );

  it('blocks values written with full-width characters', () => {
    expect(
      violatesTier2(['ＡＢ１２３４５６Ｃ'], knowledge([VALUES[1] ?? 'x'])),
    ).toBe(true);
  });

  it('ignores values shorter than six letters and digits', () => {
    const k = knowledge([{ type: 'SECRET', value: 'pw-12' }]);
    expect(k.formHashes.size).toBe(0);
    expect(violatesTier2(['password pw-12'], k)).toBe(false);
  });

  it('needs the keyed hash to agree, not only the rolling value', () => {
    const k = knowledge(['dana@example.com']);
    // The same rolling values, but hashes of other forms.
    const forged: NetKnowledge = {
      ...k,
      formHashes: new Set([matcher.hash('somethingelse')]),
    };
    expect(violatesTier2(['dana@example.com'], forged)).toBe(false);
  });
});

describe('decideRequest', () => {
  it('applies tier 1 only to message endpoints', () => {
    const k = knowledge();
    expect(
      decideRequest(
        { all: ['dana@example.com'], message: null, messageParts: null },
        k,
      ),
    ).toEqual({ block: false });
    expect(
      decideRequest(
        {
          all: ['dana@example.com'],
          message: ['dana@example.com'],
          messageParts: ['dana@example.com'],
        },
        k,
      ),
    ).toEqual({ block: true, tier: 1 });
  });

  it('applies tier 2 to every request', () => {
    expect(
      decideRequest(
        {
          all: ['https://x.example/?e=dana@example.com'],
          message: null,
          messageParts: null,
        },
        knowledge(['dana@example.com']),
      ),
    ).toEqual({ block: true, tier: 2 });
  });

  it('allows a masked message', () => {
    expect(
      decideRequest(
        {
          all: ['write to standin.1@example.net'],
          message: ['write to standin.1@example.net'],
          messageParts: ['write to standin.1@example.net'],
        },
        knowledge(['dana@example.com'], ['standin.1@example.net']),
      ),
    ).toEqual({ block: false });
  });
});

describe('tier 2 on decoded request text', () => {
  const k = knowledge([
    {
      type: 'NATIONAL_ID',
      subtype: 'UK_NINO',
      country: 'GB',
      value: 'AB123456C',
    },
    { type: 'PHONE', country: 'GB', value: '07400 123456' },
  ]);
  const request = (url: string, ...texts: string[]) =>
    requestTexts(
      {
        url: new URL(url),
        method: 'POST',
        body: { texts, skippedBinary: false },
      },
      chatgptNetRules,
    );

  it('finds a value %-encoded in the query or path', () => {
    const query = request(
      'https://telemetry.example/x?d=%41%42%31%32%33%34%35%36%43',
    );
    expect(violatesTier2(query.all, k)).toBe(true);
    const path = request('https://telemetry.example/u/%2B44%207400%20123456');
    expect(violatesTier2(path.all, k)).toBe(true);
  });

  it('finds a value written with JSON escapes in a string', () => {
    const json = request(
      'https://telemetry.example/log',
      '{"v":"\\u0041\\u0042123456\\u0043"}',
    );
    expect(violatesTier2(json.all, k)).toBe(true);
  });

  it('passes request text without the values', () => {
    const clean = request(
      'https://telemetry.example/x?d=%41%42',
      '{"v":"standin"}',
    );
    expect(violatesTier2(clean.all, k)).toBe(false);
  });
});
