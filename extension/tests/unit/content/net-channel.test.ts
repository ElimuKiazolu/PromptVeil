import { afterEach, describe, expect, it, vi } from 'vitest';
import { chatgptNetRules } from '@/src/adapters/chatgpt.ts';
import { startNetBridge } from '@/src/content/net-bridge.ts';
import type { StandInMapping } from '@/src/core/restore/index.ts';
import { startMainChannel } from '@/src/net/channel.ts';
import { installNetGuard } from '@/src/net/guard.ts';
import type { NetWindow } from '@/src/net/wrappers.ts';
import {
  NET_KEY_OFFER,
  NET_MAIN_HELLO,
  type NetAddition,
} from '@/src/shared/net-protocol.ts';

/** A document as it is at document_start: no element besides the root. */
function documentAtStart(): Document {
  const doc = document.implementation.createHTMLDocument('');
  doc.documentElement.replaceChildren();
  return doc;
}

/** The parser has created elements: page scripts may run from now on. */
function pageScriptsMayRun(doc: Document): void {
  doc.documentElement.append(doc.createElement('head'));
}

const DANA: StandInMapping = {
  standIn: 'standin.1@example.net',
  real: 'dana@example.com',
  boundary: 'email',
};

const VALID_KEY = 'ab'.repeat(32);

function fakeWindow() {
  const sent: string[] = [];
  /** What each fake transport was given, in order. */
  const payloads: unknown[] = [];
  class FakeXhr extends EventTarget {
    opened: [string, string] | null = null;
    open(method: string, url: string): void {
      this.opened = [method, url];
    }
    send(body?: unknown): void {
      payloads.push(body);
      sent.push('xhr');
    }
  }
  class FakeWebSocket extends EventTarget {
    url = 'wss://chatgpt.com/socket';
    send(data?: unknown): void {
      payloads.push(data);
      sent.push('ws');
    }
  }
  class FakeNavigator {
    sendBeacon(url: string | URL, data?: unknown): boolean {
      payloads.push([url, data]);
      sent.push('beacon');
      return true;
    }
  }
  const win = {
    fetch: () => {
      sent.push('fetch');
      return Promise.resolve(new Response('ok'));
    },
    XMLHttpRequest: FakeXhr,
    WebSocket: FakeWebSocket,
    Navigator: FakeNavigator,
    navigator: new FakeNavigator(),
    ProgressEvent: Event,
    location: { href: 'https://chatgpt.com/c/abc' },
    setTimeout: (handler: () => void) => setTimeout(handler, 0),
  };
  return { win: win as unknown as NetWindow, sent, FakeXhr, FakeNavigator };
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
    startMainChannel(doc, { onKey, onAdd: vi.fn() });
    expect(bridge.isReady()).toBe(true);
    expect(onKey).toHaveBeenCalledTimes(1);
  });

  it('completes when the MAIN-world net starts first', () => {
    const doc = documentAtStart();
    const onKey = vi.fn();
    startMainChannel(doc, { onKey, onAdd: vi.fn() });
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
    startMainChannel(doc, { onKey: vi.fn(), onAdd: vi.fn() });
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
    startMainChannel(doc, { onKey, onAdd: vi.fn() });
    pageScriptsMayRun(doc);
    doc.dispatchEvent(new CustomEvent(NET_KEY_OFFER, { detail: VALID_KEY }));
    expect(onKey).not.toHaveBeenCalled();
  });

  it('accepts only the first key', () => {
    const doc = documentAtStart();
    const onKey = vi.fn();
    startMainChannel(doc, { onKey, onAdd: vi.fn() });
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
    startMainChannel(doc, { onKey, onAdd: vi.fn() });
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
    startMainChannel(doc, { onKey: vi.fn(), onAdd: vi.fn() });
    expect(bridge.isReady()).toBe(false);
    expect(
      info.mock.calls.some((c) => String(c[0]).includes('net.missing')),
    ).toBe(true);
  });

  it('sends hashes of real values, never the values themselves', () => {
    const doc = documentAtStart();
    const additions: NetAddition[] = [];
    startMainChannel(doc, {
      onKey: vi.fn(),
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
    expect(additions[0]?.hashes[0]).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(seen)).not.toContain('dana');
  });

  it('logs reports from the net with fixed codes only', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const doc = documentAtStart();
    const bridge = startNetBridge(doc);
    const channel = startMainChannel(doc, { onKey: vi.fn(), onAdd: vi.fn() });
    expect(bridge.isReady()).toBe(true);
    channel.report({
      event: 'net.blocked',
      tier: 2,
      category: 'other',
      transport: 'beacon',
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

  it('tier 2 leaves other emails alone, such as the account email', async () => {
    const { win, sent, bridge } = setUpGuard();
    bridge.sync([DANA]);
    await win.fetch('https://chatgpt.com/backend-api/settings', {
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
});
