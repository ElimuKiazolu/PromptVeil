import { describe, expect, it } from 'vitest';
import {
  MAX_BLOCKED_FORMS,
  parseReport,
  parseVerdict,
  parseVerifyRequest,
} from '@/src/shared/net-protocol.ts';

const write = {
  event: 'net.write',
  method: 'POST',
  path: '/backend-api/conversation/:id/writing-blocks',
  transport: 'fetch',
  category: 'writing-block',
  fields: ['conversation_id', 'writing_block.metadata.subject', '?'],
  body: 'gzip-json',
  checked: 'full',
  result: 'possible',
};

describe('parseVerdict', () => {
  it('reads a verdict with its possible count', () => {
    expect(
      parseVerdict(JSON.stringify({ id: 3, block: false, possible: 2 })),
    ).toEqual({ id: 3, block: false, possible: 2 });
  });

  it('rejects a verdict without a valid possible count', () => {
    for (const possible of [undefined, -1, 1.5, '2']) {
      expect(
        parseVerdict(JSON.stringify({ id: 3, block: false, possible })),
      ).toBeNull();
    }
  });
});

describe('parseReport', () => {
  it('reads a write report', () => {
    expect(parseReport(JSON.stringify(write))).toEqual(write);
  });

  it('rejects a write report that could carry values', () => {
    for (const change of [
      { path: '/c/dana@example.com' },
      { path: '/x y' },
      { fields: ['note dana@example.com'] },
      { fields: Array.from({ length: 41 }, () => 'a') },
      { method: 'post me' },
      { body: 'JSON' },
      { checked: 'partly' },
      { result: 'maybe' },
      { category: 'settings' },
    ]) {
      expect(
        parseReport(JSON.stringify({ ...write, ...change })),
        JSON.stringify(change),
      ).toBeNull();
    }
  });

  it('reads a skipped body report with its reason', () => {
    const report = {
      event: 'net.skipped-binary',
      category: 'write',
      transport: 'beacon',
      reason: 'compressed',
    };
    expect(parseReport(JSON.stringify(report))).toEqual(report);
    expect(
      parseReport(JSON.stringify({ ...report, reason: 'other' })),
    ).toBeNull();
  });
});

describe('parseVerifyRequest', () => {
  it('reads the texts and the write category', () => {
    expect(
      parseVerifyRequest(
        JSON.stringify({ id: 1, texts: ['a'], category: 'writing-block' }),
      ),
    ).toEqual({ id: 1, texts: ['a'], category: 'writing-block' });
  });

  it('rejects a request without a known category', () => {
    for (const category of [undefined, 'card', 3]) {
      expect(
        parseVerifyRequest(JSON.stringify({ id: 1, texts: ['a'], category })),
      ).toBeNull();
    }
  });
});

describe('blocked reports', () => {
  const blocked = {
    event: 'net.blocked',
    tier: 2,
    category: 'write',
    transport: 'xhr',
    cause: 'masked',
    emails: 0,
    forms: ['0f'.repeat(32)],
  };

  it('reads the cause, the email count and the keyed form hashes', () => {
    expect(parseReport(JSON.stringify(blocked))).toEqual(blocked);
    const email = { ...blocked, tier: 1, cause: 'email', emails: 2, forms: [] };
    expect(parseReport(JSON.stringify(email))).toEqual(email);
  });

  it('rejects anything that is not a fixed code, a count or a hash', () => {
    for (const change of [
      { cause: 'other' },
      { emails: -1 },
      { emails: 'two' },
      { forms: ['dana@example.com'] },
      { forms: 'ab' },
      {
        forms: Array.from({ length: MAX_BLOCKED_FORMS + 1 }, () =>
          '0f'.repeat(32),
        ),
      },
      { tier: 3 },
    ]) {
      expect(parseReport(JSON.stringify({ ...blocked, ...change }))).toBeNull();
    }
  });
});
