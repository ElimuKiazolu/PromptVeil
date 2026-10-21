import { describe, expect, it } from 'vitest';
import {
  collectJsonStrings,
  decideRequest,
  parseJsonText,
  violatesTier1,
  violatesTier2,
  type NetKnowledge,
} from '@/src/core/net/checks.ts';
import { createValueHasher } from '@/src/core/net/hash.ts';
import { isSpikeStandIn } from '@/src/core/spike-standin.ts';

const hash = createValueHasher('c3'.repeat(32));

function knowledge(real: string[] = [], standIns: string[] = []): NetKnowledge {
  return {
    standIns: new Set(standIns),
    isStandIn: isSpikeStandIn,
    realValueHashes: new Set(real.map((v) => hash('email', v))),
    hash,
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
        hash: null,
      }),
    ).toBe(false);
  });
});

describe('decideRequest', () => {
  it('applies tier 1 only to message endpoints', () => {
    const k = knowledge();
    expect(
      decideRequest({ all: ['dana@example.com'], message: null }, k),
    ).toEqual({ block: false });
    expect(
      decideRequest(
        { all: ['dana@example.com'], message: ['dana@example.com'] },
        k,
      ),
    ).toEqual({ block: true, tier: 1 });
  });

  it('applies tier 2 to every request', () => {
    expect(
      decideRequest(
        { all: ['https://x.example/?e=dana@example.com'], message: null },
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
        },
        knowledge(['dana@example.com'], ['standin.1@example.net']),
      ),
    ).toEqual({ block: false });
  });
});
