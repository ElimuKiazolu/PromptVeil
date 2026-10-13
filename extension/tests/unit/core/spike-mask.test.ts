import { describe, expect, it } from 'vitest';
import { createSpikeMasker } from '@/src/core/spike-mask.ts';
import { detectEmails } from '@/src/core/detect/rules/email.ts';

describe('createSpikeMasker', () => {
  it('replaces an email with a stand-in on example.net', () => {
    const mask = createSpikeMasker().transform;
    expect(mask('Write to dana.whitfield@example.com today')).toBe(
      'Write to standin.1@example.net today',
    );
  });

  it('leaves text without emails unchanged', () => {
    const mask = createSpikeMasker().transform;
    const text = 'No addresses here.\nJust two lines.';
    expect(mask(text)).toBe(text);
    expect(mask('')).toBe('');
  });

  it('gives each distinct email its own stand-in', () => {
    const mask = createSpikeMasker().transform;
    expect(mask('a@example.com, b@example.org and c@example.net')).toBe(
      'standin.1@example.net, standin.2@example.net and standin.3@example.net',
    );
  });

  it('keeps the same stand-in for the same email across calls', () => {
    const mask = createSpikeMasker().transform;
    expect(mask('first dana@example.com')).toBe('first standin.1@example.net');
    expect(mask('other ops@example.org')).toBe('other standin.2@example.net');
    expect(mask('again dana@example.com')).toBe('again standin.1@example.net');
  });

  it('treats letter case as the same address', () => {
    const mask = createSpikeMasker().transform;
    expect(mask('Dana@Example.com and dana@example.com')).toBe(
      'standin.1@example.net and standin.1@example.net',
    );
  });

  it('keeps separate maskers independent', () => {
    expect(createSpikeMasker().transform('x@example.com')).toBe(
      'standin.1@example.net',
    );
    expect(createSpikeMasker().transform('y@example.com')).toBe(
      'standin.1@example.net',
    );
  });

  it('keeps surrounding text in place when lengths differ', () => {
    const mask = createSpikeMasker().transform;
    const text =
      'Short a@b.co then a much longer address dana.whitfield+billing@mail.example.com.\nEnd.';
    expect(mask(text)).toBe(
      'Short standin.1@example.net then a much longer address standin.2@example.net.\nEnd.',
    );
  });

  it('does not mask a stand-in it already issued', () => {
    const mask = createSpikeMasker().transform;
    const masked = mask('dana@example.com');
    expect(mask(`edited: ${masked}`)).toBe(`edited: ${masked}`);
  });

  it('produces output whose emails are only stand-ins', () => {
    const mask = createSpikeMasker().transform;
    const masked = mask('(a@example.com) "b@example.org" <c@example.co.uk>.');
    expect(detectEmails(masked).map((s) => s.value)).toEqual([
      'standin.1@example.net',
      'standin.2@example.net',
      'standin.3@example.net',
    ]);
  });

  it('exposes the issued mappings as a stand-in source', () => {
    const { transform, source } = createSpikeMasker();
    expect(source.version).toBe(0);
    expect(source.mappings()).toEqual([]);

    transform('Dana@Example.com and ops@example.org');
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
    transform('dana@example.com again');
    expect(source.version).toBe(2);
  });
});
