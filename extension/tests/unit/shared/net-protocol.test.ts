import { describe, expect, it } from 'vitest';
import { parseReport, parseVerdict } from '@/src/shared/net-protocol.ts';

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
