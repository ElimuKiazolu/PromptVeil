import { describe, expect, it } from 'vitest';
import {
  createMasker,
  fitsPrompt,
  issueStandIns,
  MAX_STAND_IN_ATTEMPTS,
  promptView,
  StandInsExhaustedError,
  type CommittedValue,
  type IssueVault,
  type StandInFactory,
} from '@/src/core/masker.ts';
import type { MaskItem } from '@/src/shared/vault-protocol.ts';
import { createMemoryMasker, numberedStandIns } from '../memory-masker.ts';
import { detectEmailsOnly } from '../spike-detect.ts';
import { detectEmails } from '@/src/core/detect/rules/email.ts';

describe('createMasker', () => {
  it('replaces an email with a stand-in on example.net', async () => {
    const mask = createMemoryMasker({ detect: detectEmailsOnly }).transform;
    expect(await mask('Write to dana.whitfield@example.com today')).toBe(
      'Write to standin.1@example.net today',
    );
  });

  it('leaves text without emails unchanged', async () => {
    const mask = createMemoryMasker({ detect: detectEmailsOnly }).transform;
    const text = 'No addresses here.\nJust two lines.';
    expect(await mask(text)).toBe(text);
    expect(await mask('')).toBe('');
  });

  it('gives each distinct email its own stand-in', async () => {
    const mask = createMemoryMasker({ detect: detectEmailsOnly }).transform;
    expect(await mask('a@example.com, b@example.org and c@example.net')).toBe(
      'standin.1@example.net, standin.2@example.net and standin.3@example.net',
    );
  });

  it('keeps the same stand-in for the same email across calls', async () => {
    const mask = createMemoryMasker({ detect: detectEmailsOnly }).transform;
    expect(await mask('first dana@example.com')).toBe(
      'first standin.1@example.net',
    );
    expect(await mask('other ops@example.org')).toBe(
      'other standin.2@example.net',
    );
    expect(await mask('again dana@example.com')).toBe(
      'again standin.1@example.net',
    );
  });

  it('treats letter case as the same address', async () => {
    const mask = createMemoryMasker({ detect: detectEmailsOnly }).transform;
    expect(await mask('Dana@Example.com and dana@example.com')).toBe(
      'standin.1@example.net and standin.1@example.net',
    );
  });

  it('keeps separate maskers independent', async () => {
    expect(
      await createMemoryMasker({ detect: detectEmailsOnly }).transform(
        'x@example.com',
      ),
    ).toBe('standin.1@example.net');
    expect(
      await createMemoryMasker({ detect: detectEmailsOnly }).transform(
        'y@example.com',
      ),
    ).toBe('standin.1@example.net');
  });

  it('keeps surrounding text in place when lengths differ', async () => {
    const mask = createMemoryMasker({ detect: detectEmailsOnly }).transform;
    const text =
      'Short a@b.co then a much longer address dana.whitfield+billing@mail.example.com.\nEnd.';
    expect(await mask(text)).toBe(
      'Short standin.1@example.net then a much longer address standin.2@example.net.\nEnd.',
    );
  });

  it('does not mask a stand-in it already issued', async () => {
    const mask = createMemoryMasker({ detect: detectEmailsOnly }).transform;
    const masked = await mask('dana@example.com');
    expect(await mask(`edited: ${masked}`)).toBe(`edited: ${masked}`);
  });

  it('produces output whose emails are only stand-ins', async () => {
    const mask = createMemoryMasker({ detect: detectEmailsOnly }).transform;
    const masked = await mask(
      '(a@example.com) "b@example.org" <c@example.co.uk>.',
    );
    expect(detectEmails(masked).map((s) => s.value)).toEqual([
      'standin.1@example.net',
      'standin.2@example.net',
      'standin.3@example.net',
    ]);
  });

  it('masks emails written with full-width characters or zero-width characters inside', async () => {
    const mask = createMemoryMasker({ detect: detectEmailsOnly }).transform;
    expect(await mask('mail ｄａｎａ＠ｅｘａｍｐｌｅ．ｃｏｍ now')).toBe(
      'mail standin.1@example.net now',
    );
    expect(await mask('mail ops@exam\u200Bple.org now')).toBe(
      'mail standin.2@example.net now',
    );
  });

  it('masks only confirmed EMAIL detections from the detector it is given', async () => {
    const text = 'a@example.com b@example.com';
    const { transform } = createMemoryMasker({
      detect: () =>
        Promise.resolve([
          {
            type: 'EMAIL',
            subtype: null,
            country: null,
            start: 0,
            end: 13,
            value: 'a@example.com',
            confidence: 1,
            validated: true,
            source: 'rule',
            status: 'confirmed',
            alternatives: [],
          },
          {
            type: 'EMAIL',
            subtype: null,
            country: null,
            start: 14,
            end: 27,
            value: 'b@example.com',
            confidence: 0.5,
            validated: true,
            source: 'rule',
            status: 'possible',
            alternatives: [],
          },
        ]),
    });
    expect(await transform(text)).toBe('standin.1@example.net b@example.com');
  });

  it('rejects when detection fails, so the send is blocked', async () => {
    const { transform } = createMemoryMasker({
      detect: () => Promise.reject(new Error('detector failed')),
    });
    await expect(transform('a@example.com')).rejects.toThrow('detector failed');
  });

  it('asks the vault once per value, with its normal form', async () => {
    const { transform, issued } = createMemoryMasker({
      detect: detectEmailsOnly,
    });
    await transform('Dana@Example.com, dana@example.com and ops@example.org');
    expect(issued).toEqual([
      [
        {
          type: 'EMAIL',
          subtype: null,
          country: null,
          value: 'Dana@Example.com',
          normalised: 'dana@example.com',
        },
        {
          type: 'EMAIL',
          subtype: null,
          country: null,
          value: 'ops@example.org',
          normalised: 'ops@example.org',
        },
      ],
    ]);
  });

  it('does not ask the vault when there is nothing to mask', async () => {
    const { transform, issued } = createMemoryMasker({
      detect: detectEmailsOnly,
    });
    expect(await transform('no address here')).toBe('no address here');
    // A stand-in from another page load or conversation is left alone.
    expect(await transform('old standin.1.zz01@example.net')).toBe(
      'old standin.1.zz01@example.net',
    );
    expect(issued).toEqual([]);
  });

  it('rejects when the vault fails, so the send is blocked', async () => {
    const { transform } = createMasker({
      detect: detectEmailsOnly,
      normalise: (detection) => detection.value,
      engine: () => Promise.resolve(numberedStandIns),
      mask: () => Promise.reject(new Error('vault failed')),
      isIssued: () => false,
      entityTypes: new Set(['EMAIL']),
    });
    await expect(transform('a@example.com')).rejects.toThrow('vault failed');
  });

  it('rejects when the stand-in engine cannot load, so the send is blocked', async () => {
    const { transform } = createMasker({
      detect: detectEmailsOnly,
      normalise: (detection) => detection.value,
      engine: () => Promise.reject(new Error('load-failed')),
      mask: () => Promise.resolve([]),
      isIssued: () => false,
      entityTypes: new Set(['EMAIL']),
    });
    await expect(transform('a@example.com')).rejects.toThrow('load-failed');
  });

  it('rejects a reply with the wrong number of stand-ins', async () => {
    const mask = (items: readonly MaskItem[]) =>
      Promise.resolve(items.slice(1).map(() => 'standin.1@example.net'));
    const { transform } = createMasker({
      detect: detectEmailsOnly,
      normalise: (detection) => detection.value,
      engine: () => Promise.resolve(numberedStandIns),
      mask,
      isIssued: () => false,
      entityTypes: new Set(['EMAIL']),
    });
    await expect(transform('a@example.com b@example.org')).rejects.toThrow(
      RangeError,
    );
  });
});

// Fixture-style addresses (example.com and example.org are reserved).
const item = (local: string): MaskItem => ({
  type: 'EMAIL',
  subtype: null,
  country: null,
  value: `${local}@example.com`,
  normalised: `${local}@example.com`,
});

/** A vault that prepares every item as new and answers commits from a script. */
function scriptedVault(
  answer: (standIn: string, round: number) => CommittedValue['kind'],
): IssueVault & { commits: string[][] } {
  const commits: string[][] = [];
  return {
    commits,
    prepare: (items) =>
      Promise.resolve({
        dateOffsetDays: 30,
        values: items.map((_, index) => ({
          kind: 'new' as const,
          seed: new Uint8Array(32),
          number: index + 1,
        })),
      }),
    commit: (entries) => {
      const round = commits.length;
      commits.push(entries.map((entry) => entry.standIn));
      return Promise.resolve(
        entries.map((entry): CommittedValue => {
          const kind = answer(entry.standIn, round);
          return kind === 'taken' ? { kind } : { kind, standIn: entry.standIn };
        }),
      );
    },
  };
}

const options = (
  standIn: StandInFactory = numberedStandIns,
  fits: (item: MaskItem, standIn: { value: string }) => boolean = () => true,
) => ({ standIn, fits, now: 0 });

describe('issueStandIns', () => {
  it('commits one stand-in per new value and keeps stored ones', async () => {
    const vault = scriptedVault(() => 'inserted');
    expect(
      await issueStandIns([item('a'), item('b')], vault, options()),
    ).toEqual(['standin.1@example.net', 'standin.2@example.net']);
    expect(vault.commits).toHaveLength(1);
  });

  it('moves a taken stand-in to its next attempt, deterministically', async () => {
    const taken = new Set(['standin.1@example.net', 'standin.2@example.net']);
    const run = async () => {
      const vault = scriptedVault((standIn) =>
        taken.has(standIn) ? 'taken' : 'inserted',
      );
      return {
        standIns: await issueStandIns([item('a')], vault, options()),
        commits: vault.commits,
      };
    };
    const first = await run();
    expect(first.standIns).toEqual(['standin.3@example.net']);
    expect(first.commits).toEqual([
      ['standin.1@example.net'],
      ['standin.2@example.net'],
      ['standin.3@example.net'],
    ]);
    expect(await run()).toEqual(first);
  });

  it('never gives two new values of one send the same stand-in', async () => {
    // Both values' first choice is the same text.
    const same: StandInFactory = (_request, _seed, attempt) => {
      const value = `standin.${attempt.toString()}@example.net`;
      return { value, normalised: value, reserved: true };
    };
    const vault = scriptedVault(() => 'inserted');
    expect(
      await issueStandIns([item('a'), item('b')], vault, options(same)),
    ).toEqual(['standin.0@example.net', 'standin.1@example.net']);
  });

  it('skips attempts that conflict with the prompt or have no stand-in', async () => {
    const vault = scriptedVault(() => 'inserted');
    const sometimes: StandInFactory = (request, seed, attempt) =>
      attempt === 0 ? null : numberedStandIns(request, seed, attempt);
    const result = await issueStandIns(
      [item('a')],
      vault,
      options(
        sometimes,
        (_item, standIn) => standIn.value !== 'standin.2@example.net',
      ),
    );
    expect(result).toEqual(['standin.3@example.net']);
    expect(vault.commits).toEqual([['standin.3@example.net']]);
  });

  it(`fails closed after ${MAX_STAND_IN_ATTEMPTS.toString()} attempts`, async () => {
    const vault = scriptedVault(() => 'taken');
    await expect(
      issueStandIns([item('a')], vault, options()),
    ).rejects.toBeInstanceOf(StandInsExhaustedError);
    expect(vault.commits).toHaveLength(MAX_STAND_IN_ATTEMPTS);
    // Nothing the prompt accepts: no commit at all.
    const silent = scriptedVault(() => 'inserted');
    await expect(
      issueStandIns(
        [item('a')],
        silent,
        options(numberedStandIns, () => false),
      ),
    ).rejects.toBeInstanceOf(StandInsExhaustedError);
    expect(silent.commits).toEqual([]);
  });

  it('uses the stand-in another tab stored first', async () => {
    const vault: IssueVault = {
      ...scriptedVault(() => 'inserted'),
      commit: (entries) =>
        Promise.resolve(
          entries.map(() => ({
            kind: 'existing' as const,
            standIn: 'standin.9.abcd@example.net',
          })),
        ),
    };
    expect(await issueStandIns([item('a')], vault, options())).toEqual([
      'standin.9.abcd@example.net',
    ]);
  });
});

describe('prompt checks (TR-S3)', () => {
  const detection = (value: string, start: number) => ({
    type: 'EMAIL' as const,
    subtype: null,
    country: null,
    start,
    end: start + value.length,
    value,
    confidence: 1,
    validated: true,
    source: 'rule' as const,
    status: 'confirmed' as const,
    alternatives: [],
  });
  const text = 'Mail a@example.com; ref standin.7@example.net, b@example.org';
  const view = promptView(
    text,
    [detection('a@example.com', 5), detection('b@example.org', 47)],
    [item('a')],
  );
  const standIn = (value: string) => ({
    value,
    normalised: value,
    reserved: true,
  });

  it('refuses a stand-in that appears elsewhere in the prompt', () => {
    expect(fitsPrompt(view, 'EMAIL', standIn('standin.7@example.net'))).toBe(
      false,
    );
    // Compared by letters and digits, in any case.
    expect(fitsPrompt(view, 'EMAIL', standIn('STANDIN-7@example.net'))).toBe(
      false,
    );
  });

  it('refuses a stand-in equal to any value detected in the prompt', () => {
    expect(fitsPrompt(view, 'EMAIL', standIn('B@example.org'))).toBe(false);
    expect(fitsPrompt(view, 'EMAIL', standIn('a@example.com'))).toBe(false);
  });

  it('accepts a stand-in found nowhere in the prompt', () => {
    expect(fitsPrompt(view, 'EMAIL', standIn('standin.8@example.net'))).toBe(
      true,
    );
  });

  it('does not join text across a masked value', () => {
    // "x" + "y" around a detection must not make "xy".
    const joined = promptView(
      'x a@example.com y',
      [detection('a@example.com', 2)],
      [],
    );
    expect(fitsPrompt(joined, 'EMAIL', standIn('xy'))).toBe(true);
  });
});
