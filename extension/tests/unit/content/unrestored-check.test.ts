import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  countUnrestored,
  createUnrestoredCheck,
  unrestoredReason,
} from '@/src/content/unrestored-check.ts';
import type {
  StandInMapping,
  StandInSource,
} from '@/src/core/restore/types.ts';

// Reserved-domain addresses only (RFC 2606).
const MAPPING: StandInMapping = {
  standIn: 'kai_hale@example.org',
  real: 'lee_park@example.com',
  boundary: 'email',
};
const source = (mappings: StandInMapping[]): StandInSource => ({
  version: 1,
  mappings: () => mappings,
  subscribe: () => () => undefined,
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe('restore diagnostics', () => {
  it('names the reason from how the load ended', () => {
    expect(
      unrestoredReason({ status: 'keys-lost', mappings: 0, failed: 0 }),
    ).toBe('keys-lost');
    expect(unrestoredReason({ status: 'error', mappings: 0, failed: 0 })).toBe(
      'load-failed',
    );
    expect(unrestoredReason({ status: 'ready', mappings: 3, failed: 1 })).toBe(
      'decrypt-failed',
    );
    expect(unrestoredReason({ status: 'ready', mappings: 0, failed: 0 })).toBe(
      'no-mappings',
    );
    expect(unrestoredReason({ status: 'ready', mappings: 3, failed: 0 })).toBe(
      'no-match',
    );
  });

  it('counts known stand-ins left on screen and unknown email stand-ins', () => {
    expect(
      countUnrestored(
        ['Write to kai_hale@example.org and green_koch@example.org today.'],
        source([MAPPING]),
      ),
    ).toBe(2);
    expect(
      countUnrestored(['Write to lee_park@example.com'], source([MAPPING])),
    ).toBe(0);
    expect(countUnrestored(['green_koch@example.org'], source([]))).toBe(1);
  });

  it('logs counts and a code once the restorer had time, skipping editors', async () => {
    vi.useFakeTimers();
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const message = document.createElement('div');
    message.textContent = 'Reply to green_koch@example.org';
    const card = document.createElement('div');
    card.setAttribute('contenteditable', 'true');
    card.textContent = 'Dear kai_hale@example.org';
    message.append(card);
    document.body.append(message);
    const check = createUnrestoredCheck({
      adapter: { getMessageContainers: () => [message] },
      source: source([]),
      signal: new AbortController().signal,
      delayMs: 100,
    });
    check({ status: 'ready', mappings: 0, failed: 0 });
    await vi.advanceTimersByTimeAsync(100);
    const lines = info.mock.calls.map((call) => String(call[0]));
    expect(
      lines.some((l) => l.endsWith(' restore.unrestored no-mappings count=1')),
    ).toBe(true);
    expect(lines.join('\n')).not.toContain('green_koch');
  });
});
