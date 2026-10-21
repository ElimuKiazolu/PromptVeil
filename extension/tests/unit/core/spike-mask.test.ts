import { describe, expect, it } from 'vitest';
import { createSpikeMasker } from '@/src/core/spike-mask.ts';
import { detectEmails } from '@/src/core/detect/rules/email.ts';

describe('createSpikeMasker', () => {
  it('replaces an email with a stand-in on example.net', async () => {
    const mask = createSpikeMasker().transform;
    expect(await mask('Write to dana.whitfield@example.com today')).toBe(
      'Write to standin.1@example.net today',
    );
  });

  it('leaves text without emails unchanged', async () => {
    const mask = createSpikeMasker().transform;
    const text = 'No addresses here.\nJust two lines.';
    expect(await mask(text)).toBe(text);
    expect(await mask('')).toBe('');
  });

  it('gives each distinct email its own stand-in', async () => {
    const mask = createSpikeMasker().transform;
    expect(await mask('a@example.com, b@example.org and c@example.net')).toBe(
      'standin.1@example.net, standin.2@example.net and standin.3@example.net',
    );
  });

  it('keeps the same stand-in for the same email across calls', async () => {
    const mask = createSpikeMasker().transform;
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
    const mask = createSpikeMasker().transform;
    expect(await mask('Dana@Example.com and dana@example.com')).toBe(
      'standin.1@example.net and standin.1@example.net',
    );
  });

  it('keeps separate maskers independent', async () => {
    expect(await createSpikeMasker().transform('x@example.com')).toBe(
      'standin.1@example.net',
    );
    expect(await createSpikeMasker().transform('y@example.com')).toBe(
      'standin.1@example.net',
    );
  });

  it('keeps surrounding text in place when lengths differ', async () => {
    const mask = createSpikeMasker().transform;
    const text =
      'Short a@b.co then a much longer address dana.whitfield+billing@mail.example.com.\nEnd.';
    expect(await mask(text)).toBe(
      'Short standin.1@example.net then a much longer address standin.2@example.net.\nEnd.',
    );
  });

  it('does not mask a stand-in it already issued', async () => {
    const mask = createSpikeMasker().transform;
    const masked = await mask('dana@example.com');
    expect(await mask(`edited: ${masked}`)).toBe(`edited: ${masked}`);
  });

  it('produces output whose emails are only stand-ins', async () => {
    const mask = createSpikeMasker().transform;
    const masked = await mask(
      '(a@example.com) "b@example.org" <c@example.co.uk>.',
    );
    expect(detectEmails(masked).map((s) => s.value)).toEqual([
      'standin.1@example.net',
      'standin.2@example.net',
      'standin.3@example.net',
    ]);
  });

  it('exposes the issued mappings as a stand-in source', async () => {
    const { transform, source } = createSpikeMasker();
    expect(source.version).toBe(0);
    expect(source.mappings()).toEqual([]);

    await transform('Dana@Example.com and ops@example.org');
    expect(source.version).toBe(2);
    expect(source.mappings()).toEqual([
      {
        standIn: 'standin.1@example.net',
        real: 'Dana@Example.com',
        boundary: 'email',
      },
      {
        standIn: 'standin.2@example.net',
        real: 'ops@example.org',
        boundary: 'email',
      },
    ]);

    // Reusing an existing mapping does not change the version.
    await transform('dana@example.com again');
    expect(source.version).toBe(2);
  });

  it('tags stand-ins with the page-load tag so numbers never collide', async () => {
    const { transform, source } = createSpikeMasker({ sessionTag: 'k3f9' });
    expect(await transform('mail dana@example.com')).toBe(
      'mail standin.1.k3f9@example.net',
    );
    expect(source.mappings()[0]?.standIn).toBe('standin.1.k3f9@example.net');
    // A stand-in from another page load is recognised and left alone.
    expect(await transform('old standin.1.zz01@example.net')).toBe(
      'old standin.1.zz01@example.net',
    );
  });

  it('masks emails written with full-width characters or zero-width characters inside', async () => {
    const mask = createSpikeMasker().transform;
    expect(await mask('mail ｄａｎａ＠ｅｘａｍｐｌｅ．ｃｏｍ now')).toBe(
      'mail standin.1@example.net now',
    );
    expect(await mask('mail ops@exam\u200Bple.org now')).toBe(
      'mail standin.2@example.net now',
    );
  });

  it('masks only confirmed EMAIL detections from the detector it is given', async () => {
    const text = 'a@example.com b@example.com';
    const { transform } = createSpikeMasker({
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
    const { transform } = createSpikeMasker({
      detect: () => Promise.reject(new Error('detector failed')),
    });
    await expect(transform('a@example.com')).rejects.toThrow('detector failed');
  });

  it('rejects a malformed session tag', () => {
    expect(() => createSpikeMasker({ sessionTag: 'Bad Tag' })).toThrow(
      RangeError,
    );
  });
});
