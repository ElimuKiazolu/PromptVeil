import { describe, expect, it } from 'vitest';
import { createSpikeMasker } from '@/src/core/spike-mask.ts';
import type { MaskItem } from '@/src/shared/vault-protocol.ts';
import { createMemoryMasker } from '../memory-masker.ts';
import { detectEmailsOnly } from '../spike-detect.ts';
import { detectEmails } from '@/src/core/detect/rules/email.ts';

describe('createSpikeMasker', () => {
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
    const { transform } = createSpikeMasker({
      detect: detectEmailsOnly,
      normalise: (detection) => detection.value,
      issue: () => Promise.reject(new Error('vault failed')),
      isIssued: () => false,
    });
    await expect(transform('a@example.com')).rejects.toThrow('vault failed');
  });

  it('rejects a reply with the wrong number of stand-ins', async () => {
    const issue = (items: readonly MaskItem[]) =>
      Promise.resolve(items.slice(1).map(() => 'standin.1@example.net'));
    const { transform } = createSpikeMasker({
      detect: detectEmailsOnly,
      normalise: (detection) => detection.value,
      issue,
      isIssued: () => false,
    });
    await expect(transform('a@example.com b@example.org')).rejects.toThrow(
      RangeError,
    );
  });
});
