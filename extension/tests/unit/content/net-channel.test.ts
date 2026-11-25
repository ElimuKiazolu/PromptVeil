import { afterEach, describe, expect, it, vi } from 'vitest';
import { chatgptNetRules } from '@/src/adapters/chatgpt.ts';
import {
  startNetBridge,
  type VerifierResult,
} from '@/src/content/net-bridge.ts';
import type { StandInMapping } from '@/src/core/restore/index.ts';
import { startMainChannel } from '@/src/net/channel.ts';
import { installNetGuard, VERIFY_TIMEOUT_MS } from '@/src/net/guard.ts';
import {
  documentAtStart,
  fakeWindow,
  NINO,
  pageScriptsMayRun,
} from './net-fakes.ts';
import {
  NET_KEY_OFFER,
  NET_MAIN_HELLO,
  type NetAddition,
  type NetCategory,
  type NetReport,
} from '@/src/shared/net-protocol.ts';

const DANA: StandInMapping = {
  standIn: 'standin.1@example.net',
  real: 'dana@example.com',
  boundary: 'email',
};

const VALID_KEY = 'ab'.repeat(32);

const PASS: VerifierResult = {
  block: false,
  possible: 0,
  items: [],
  hashes: [],
};

/** MAIN-channel handlers that do nothing, with a real timer. */
function handlers() {
  return {
    onKey: vi.fn(),
    onAdd: vi.fn(),
    setTimer: (handler: () => void, ms: number) => {
      setTimeout(handler, ms);
    },
  };
}

const messageBody = (text: string): string =>
  JSON.stringify({
    action: 'next',
    messages: [
      {
        author: { role: 'user' },
        content: { content_type: 'text', parts: [text] },
      },
    ],
  });

describe('handshake between the isolated script and the MAIN-world net', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('completes when the isolated script starts first', () => {
    const doc = documentAtStart();
    const bridge = startNetBridge(doc);
    expect(bridge.isReady()).toBe(false);
    const onKey = vi.fn();
    startMainChannel(doc, { ...handlers(), onKey });
    expect(bridge.isReady()).toBe(true);
    expect(onKey).toHaveBeenCalledTimes(1);
  });

  it('completes when the MAIN-world net starts first', () => {
    const doc = documentAtStart();
    const onKey = vi.fn();
    startMainChannel(doc, { ...handlers(), onKey });
    const bridge = startNetBridge(doc);
    expect(bridge.isReady()).toBe(true);
    expect(onKey).toHaveBeenCalledTimes(1);
  });

  it('runs ready callbacks once the net confirms', () => {
    const doc = documentAtStart();
    const bridge = startNetBridge(doc);
    const ready = vi.fn();
    bridge.onReady(ready);
    expect(ready).not.toHaveBeenCalled();
    startMainChannel(doc, handlers());
    expect(ready).toHaveBeenCalledTimes(1);
    bridge.onReady(ready);
    expect(ready).toHaveBeenCalledTimes(2);
  });

  it('stays not ready when the net is missing', () => {
    const doc = documentAtStart();
    const bridge = startNetBridge(doc);
    pageScriptsMayRun(doc);
    expect(bridge.isReady()).toBe(false);
  });

  it('never hands its key to a page script that forges a hello later', () => {
    const doc = documentAtStart();
    const bridge = startNetBridge(doc);
    pageScriptsMayRun(doc);

    const offers = vi.fn();
    doc.addEventListener(NET_KEY_OFFER, offers);
    doc.dispatchEvent(new CustomEvent(NET_MAIN_HELLO));
    expect(offers).not.toHaveBeenCalled();
    expect(bridge.isReady()).toBe(false);
  });

  it('cannot be completed by a key offer forged after page scripts can run', () => {
    const doc = documentAtStart();
    const onKey = vi.fn();
    startMainChannel(doc, { ...handlers(), onKey });
    pageScriptsMayRun(doc);
    doc.dispatchEvent(new CustomEvent(NET_KEY_OFFER, { detail: VALID_KEY }));
    expect(onKey).not.toHaveBeenCalled();
  });

  it('accepts only the first key', () => {
    const doc = documentAtStart();
    const onKey = vi.fn();
    startMainChannel(doc, { ...handlers(), onKey });
    doc.dispatchEvent(new CustomEvent(NET_KEY_OFFER, { detail: VALID_KEY }));
    doc.dispatchEvent(
      new CustomEvent(NET_KEY_OFFER, { detail: 'cd'.repeat(32) }),
    );
    expect(onKey).toHaveBeenCalledTimes(1);
    expect(onKey).toHaveBeenCalledWith(VALID_KEY);
  });

  it('ignores malformed key offers', () => {
    const doc = documentAtStart();
    const onKey = vi.fn();
    startMainChannel(doc, { ...handlers(), onKey });
    for (const detail of ['short', 42, null, 'AB'.repeat(32)]) {
      doc.dispatchEvent(new CustomEvent(NET_KEY_OFFER, { detail }));
    }
    expect(onKey).not.toHaveBeenCalled();
  });

  it('does not start a handshake when it starts too late', () => {
    const doc = documentAtStart();
    pageScriptsMayRun(doc);
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const bridge = startNetBridge(doc);
    startMainChannel(doc, handlers());
    expect(bridge.isReady()).toBe(false);
    expect(
      info.mock.calls.some((c) => String(c[0]).includes('net.missing')),
    ).toBe(true);
  });

  it('sends hashes of real values, never the values themselves', () => {
    const doc = documentAtStart();
    const additions: NetAddition[] = [];
    startMainChannel(doc, {
      ...handlers(),
      onAdd: (a) => additions.push(a),
    });
    const bridge = startNetBridge(doc);
    const seen: unknown[] = [];
    // Watch every event on the document while syncing.
    const original = doc.dispatchEvent.bind(doc);
    vi.spyOn(doc, 'dispatchEvent').mockImplementation((event) => {
      if (event instanceof CustomEvent) seen.push(event.detail);
      return original(event);
    });

    bridge.sync([DANA]);
    bridge.sync([DANA]);
    expect(additions).toHaveLength(1);
    expect(additions[0]?.standIns).toEqual(['standin.1@example.net']);
    const [form] = additions[0]?.forms ?? [];
    expect(form?.length).toBe('danaexamplecom'.length);
    expect(form?.hash).toMatch(/^[0-9a-f]{64}$/u);
    expect(JSON.stringify(seen)).not.toContain('dana');
  });

  it('logs reports from the net with fixed codes only', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const doc = documentAtStart();
    const bridge = startNetBridge(doc);
    const channel = startMainChannel(doc, handlers());
    expect(bridge.isReady()).toBe(true);
    channel.report({
      event: 'net.blocked',
      tier: 2,
      category: 'other',
      transport: 'beacon',
      cause: 'masked',
      emails: 0,
      forms: [],
    });
    const lines = info.mock.calls.map((c) => String(c[0]));
    expect(
      lines.some((l) =>
        l.endsWith('net.blocked tier=2 category=other transport=beacon'),
      ),
    ).toBe(true);
  });
});

describe('installNetGuard', () => {
  function setUpGuard() {
    const doc = documentAtStart();
    const env = fakeWindow();
    installNetGuard(env.win, doc, chatgptNetRules);
    const bridge = startNetBridge(doc);
    // The detector finds nothing to mask in any message, by default.
    bridge.setVerifier(() => Promise.resolve(PASS));
    pageScriptsMayRun(doc);
    return { ...env, doc, bridge };
  }

  it('tier 1 blocks a message with an email that is not a stand-in', async () => {
    const { win, sent } = setUpGuard();
    await expect(
      win.fetch('/backend-api/f/conversation', {
        method: 'POST',
        body: messageBody('Write to dana@example.com'),
      }),
    ).rejects.toThrow(TypeError);
    expect(sent).toEqual([]);
  });

  it('tier 1 allows a masked message and stand-ins from earlier loads', async () => {
    const { win, sent, bridge } = setUpGuard();
    bridge.sync([DANA]);
    await win.fetch('/backend-api/f/conversation', {
      method: 'POST',
      body: messageBody(
        'Write to standin.1@example.net and standin.9@example.net',
      ),
    });
    expect(sent).toEqual(['fetch']);
  });

  it('tier 1 covers edit requests sent over XHR', () => {
    const { FakeXhr, sent } = setUpGuard();
    const xhr = new FakeXhr();
    xhr.open('POST', 'https://chatgpt.com/backend-api/conversation');
    xhr.send(messageBody('edited: ops@example.org'));
    expect(sent).toEqual([]);
  });

  it('tier 2 blocks a masked value in any request, anywhere', async () => {
    const { win, sent, bridge, FakeNavigator } = setUpGuard();
    bridge.sync([DANA]);
    const beacon = new FakeNavigator();
    expect(
      beacon.sendBeacon(
        'https://telemetry.example/x',
        '{"u":"Dana@Example.com"}',
      ),
    ).toBe(false);
    await expect(
      win.fetch('https://other.example/?email=dana%40example.com'),
    ).rejects.toThrow(TypeError);
    expect(sent).toEqual([]);
  });

  it('tier 2 blocks the exact beacon from the live report', () => {
    const { sent, bridge, FakeNavigator } = setUpGuard();
    bridge.sync([DANA]);
    expect(
      new FakeNavigator().sendBeacon(
        'https://example.org/x',
        'dana@example.com',
      ),
    ).toBe(false);
    expect(sent).toEqual([]);
  });

  it('tier 2 lets the beacon through before the value is masked', () => {
    const { sent, FakeNavigator } = setUpGuard();
    expect(
      new FakeNavigator().sendBeacon(
        'https://example.org/x',
        'dana@example.com',
      ),
    ).toBe(true);
    expect(sent).toEqual(['beacon']);
  });

  it('tier 2 leaves other emails alone in requests to other sites', async () => {
    const { win, sent, bridge } = setUpGuard();
    bridge.sync([DANA]);
    await win.fetch('https://telemetry.example/settings', {
      method: 'POST',
      body: '{"email":"me@example.org"}',
    });
    expect(sent).toEqual(['fetch']);
  });

  it('cannot be switched off or emptied by events a page script dispatches', async () => {
    const { win, sent, bridge, doc } = setUpGuard();
    bridge.sync([DANA]);
    for (const type of [
      NET_KEY_OFFER,
      NET_MAIN_HELLO,
      'promptveil:net-off',
      'promptveil:remove',
      `promptveil:${VALID_KEY}:add`,
    ]) {
      doc.dispatchEvent(new CustomEvent(type, { detail: VALID_KEY }));
      window.dispatchEvent(
        new CustomEvent(type, {
          detail: '{"hashes":[],"standIns":["dana@example.com"]}',
        }),
      );
    }
    await expect(
      win.fetch('https://telemetry.example/', {
        method: 'POST',
        body: 'dana@example.com',
      }),
    ).rejects.toThrow(TypeError);
    await expect(
      win.fetch('/backend-api/f/conversation', {
        method: 'POST',
        body: messageBody('to dana@example.com'),
      }),
    ).rejects.toThrow(TypeError);
    expect(sent).toEqual([]);
  });

  it('tier 2 blocks any masked type, in any writing', () => {
    const { sent, bridge, FakeNavigator } = setUpGuard();
    bridge.sync([NINO]);
    for (const body of ['ni ab123456c', '{"n":"AB-12-34-56-C"}']) {
      expect(new FakeNavigator().sendBeacon('https://x.example/', body)).toBe(
        false,
      );
    }
    expect(sent).toEqual([]);
  });

  it('a fetch message request waits for the verdict on its message text', async () => {
    const { win, sent, bridge } = setUpGuard();
    const asked: string[][] = [];
    bridge.setVerifier((texts) => {
      asked.push([...texts]);
      return Promise.resolve({
        block: texts.some((t) => t.includes('AB 12 34 56 C')),
        possible: 0,
        items: [],
        hashes: [],
      });
    });
    await expect(
      win.fetch('/backend-api/f/conversation', {
        method: 'POST',
        body: messageBody('My NI number is AB 12 34 56 C'),
      }),
    ).rejects.toThrow(TypeError);
    await win.fetch('/backend-api/f/conversation', {
      method: 'POST',
      body: messageBody('My NI number is TN 48 21 93 B'),
    });
    expect(sent).toEqual(['fetch']);
    // Only the user's text, not the rest of the body.
    expect(asked.flat()).toContain('My NI number is AB 12 34 56 C');
    expect(asked.flat()).not.toContain('next');
    expect(asked.flat()).not.toContain('user');
  });

  it('blocks a fetch message request without a verifier or when it fails', async () => {
    const { win, sent, bridge } = setUpGuard();
    bridge.setVerifier(() => Promise.reject(new Error('detection failed')));
    await expect(
      win.fetch('/backend-api/f/conversation', {
        method: 'POST',
        body: messageBody('hello'),
      }),
    ).rejects.toThrow(TypeError);
    const fresh = documentAtStart();
    const env = fakeWindow();
    installNetGuard(env.win, fresh, chatgptNetRules);
    startNetBridge(fresh);
    pageScriptsMayRun(fresh);
    await expect(
      env.win.fetch('/backend-api/f/conversation', {
        method: 'POST',
        body: messageBody('hello'),
      }),
    ).rejects.toThrow(TypeError);
    expect([...sent, ...env.sent]).toEqual([]);
  });

  it('blocks a fetch message request when no verdict comes in time', async () => {
    vi.useFakeTimers();
    try {
      const { win, sent, bridge } = setUpGuard();
      bridge.setVerifier(() => new Promise<VerifierResult>(() => undefined));
      const request = win.fetch('/backend-api/f/conversation', {
        method: 'POST',
        body: messageBody('hello'),
      });
      const outcome = request.then(
        () => 'sent',
        () => 'blocked',
      );
      await vi.advanceTimersByTimeAsync(VERIFY_TIMEOUT_MS);
      expect(await outcome).toBe('blocked');
      expect(sent).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports the verification time, never the text', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const { win } = setUpGuard();
    await win.fetch('/backend-api/f/conversation', {
      method: 'POST',
      body: messageBody('hello there'),
    });
    const lines = info.mock.calls.map((c) => String(c[0]));
    expect(
      lines.some((l) => / net\.verified ms=\d+\.\d block=false$/u.test(l)),
    ).toBe(true);
    expect(lines.join('\n')).not.toContain('hello');
  });
});

describe('block reports for notices', () => {
  function setUp() {
    const doc = documentAtStart();
    const env = fakeWindow();
    installNetGuard(env.win, doc, chatgptNetRules);
    const bridge = startNetBridge(doc);
    bridge.setVerifier(() => Promise.resolve(PASS));
    const reports: NetReport[] = [];
    bridge.onReport((report) => reports.push(report));
    const verdicts: [NetCategory, VerifierResult | null][] = [];
    bridge.onVerdict((category, result) => verdicts.push([category, result]));
    pageScriptsMayRun(doc);
    return { ...env, bridge, reports, verdicts };
  }

  const blockedReports = (reports: readonly NetReport[]) =>
    reports.filter((r) => r.event === 'net.blocked');

  it('counts the emails of a tier-1 block (no values)', () => {
    const { FakeXhr, reports } = setUp();
    const xhr = new FakeXhr();
    xhr.open('PATCH', 'https://chatgpt.com/backend-api/conversation/abc');
    xhr.send(JSON.stringify({ title: 'dana@example.com and ops@example.org' }));
    expect(blockedReports(reports)).toEqual([
      {
        event: 'net.blocked',
        tier: 1,
        category: 'write',
        transport: 'xhr',
        cause: 'email',
        emails: 2,
        forms: [
          expect.stringMatching(/^[0-9a-f]{64}$/),
          expect.stringMatching(/^[0-9a-f]{64}$/),
        ],
      },
    ]);
  });

  it('names the type of a value masked earlier through its keyed form', () => {
    const { FakeNavigator, bridge, reports } = setUp();
    bridge.sync([{ ...NINO, entity: 'NATIONAL_ID' }]);
    new FakeNavigator().sendBeacon('/ces/v1/t', 'note AB123456C');
    const [report] = blockedReports(reports);
    expect(report).toMatchObject({
      tier: 2,
      cause: 'masked',
      category: 'write',
    });
    const forms = report?.event === 'net.blocked' ? report.forms : [];
    expect(forms).toHaveLength(1);
    expect(bridge.valueOfForm(forms[0] ?? '')).toEqual({
      type: 'NATIONAL_ID',
      standIn: NINO.standIn,
    });
    expect(bridge.valueOfForm('0f'.repeat(32))).toBeNull();
  });

  it('tells listeners the verdict of a fetch write, with its category and kinds', async () => {
    const { win, bridge, reports, verdicts } = setUp();
    const items = [{ type: 'PHONE' as const, subtype: null, count: 1 }];
    bridge.setVerifier(() =>
      Promise.resolve({ block: true, possible: 0, items, hashes: [] }),
    );
    await expect(
      win.fetch('/backend-api/conversation/abc/writing-blocks', {
        method: 'POST',
        body: JSON.stringify({ writing_block: { content: 'Call me soon' } }),
      }),
    ).rejects.toThrow(TypeError);
    expect(verdicts).toEqual([
      ['writing-block', { block: true, possible: 0, items, hashes: [] }],
    ]);
    expect(blockedReports(reports)).toMatchObject([
      { cause: 'verified', category: 'writing-block', transport: 'fetch' },
    ]);
  });

  it('tells listeners a failed verification (blocked, unchecked)', async () => {
    const { win, bridge, verdicts } = setUp();
    bridge.setVerifier(() => Promise.reject(new Error('detector failed')));
    await expect(
      win.fetch('/backend-api/conversation/abc/writing-blocks', {
        method: 'POST',
        body: JSON.stringify({ writing_block: { content: 'Hello there' } }),
      }),
    ).rejects.toThrow(TypeError);
    expect(verdicts).toEqual([['writing-block', null]]);
  });
});
