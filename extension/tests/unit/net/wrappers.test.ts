import { beforeEach, describe, expect, it } from 'vitest';
import type { NetTransport } from '@/src/shared/net-protocol.ts';
import type { DescribedRequest } from '@/src/net/request.ts';
import { wrapNetwork, type NetWindow } from '@/src/net/wrappers.ts';

interface Calls {
  fetch: [RequestInfo | URL, RequestInit | undefined][];
  xhr: unknown[];
  ws: unknown[];
  beacon: [string | URL, unknown][];
}

function fakeWindow() {
  const calls: Calls = { fetch: [], xhr: [], ws: [], beacon: [] };

  class FakeXhr extends EventTarget {
    opened: [string, string] | null = null;
    open(method: string, url: string): void {
      this.opened = [method, url];
    }
    send(body?: unknown): void {
      calls.xhr.push(body);
    }
  }
  class FakeWebSocket extends EventTarget {
    url = 'wss://chatgpt.com/socket';
    send(data: unknown): void {
      calls.ws.push(data);
    }
  }
  class FakeNavigator {
    sendBeacon(url: string | URL, data?: unknown): boolean {
      calls.beacon.push([url, data]);
      return true;
    }
  }

  const win = {
    fetch: (input: RequestInfo | URL, init?: RequestInit) => {
      calls.fetch.push([input, init]);
      return Promise.resolve(new Response('ok'));
    },
    XMLHttpRequest: FakeXhr,
    WebSocket: FakeWebSocket,
    Navigator: FakeNavigator,
    ProgressEvent: Event,
    location: { href: 'https://chatgpt.com/c/abc' },
    setTimeout: (handler: () => void, timeout?: number) =>
      setTimeout(handler, timeout),
  };
  return {
    win: win as unknown as NetWindow,
    calls,
    FakeXhr,
    FakeWebSocket,
    FakeNavigator,
  };
}

describe('wrapNetwork', () => {
  let env: ReturnType<typeof fakeWindow>;
  let seen: { request: DescribedRequest; transport: NetTransport }[];

  beforeEach(() => {
    env = fakeWindow();
    seen = [];
    // Blocks any request whose body or URL mentions "secret".
    wrapNetwork(env.win, (request, transport) => {
      seen.push({ request, transport });
      const text = [request.url?.href ?? '', ...request.body.texts].join(' ');
      return !text.includes('secret');
    });
  });

  describe('fetch', () => {
    it('passes an allowed request through unchanged', async () => {
      const init = { method: 'POST', body: 'hello' };
      const response = await env.win.fetch('/backend-api/f/conversation', init);
      expect(await response.text()).toBe('ok');
      expect(env.calls.fetch).toEqual([['/backend-api/f/conversation', init]]);
      expect(seen[0]?.transport).toBe('fetch');
      expect(seen[0]?.request.url?.href).toBe(
        'https://chatgpt.com/backend-api/f/conversation',
      );
      expect(seen[0]?.request.method).toBe('POST');
    });

    it('rejects a blocked request like a network error, without sending it', async () => {
      await expect(
        env.win.fetch('/x', { method: 'POST', body: 'a secret' }),
      ).rejects.toThrow(TypeError);
      expect(env.calls.fetch).toEqual([]);
    });

    it('reads the URL, method and body of a Request', async () => {
      const request = new Request('https://chatgpt.com/y?q=secret', {
        method: 'PUT',
        body: 'b',
      });
      await expect(env.win.fetch(request)).rejects.toThrow(TypeError);
      expect(seen[0]?.request.method).toBe('PUT');
      expect(seen[0]?.request.body.texts).toEqual(['b']);
    });

    it('accepts a URL object', async () => {
      await env.win.fetch(new URL('https://example.org/z'));
      expect(seen[0]?.request.url?.href).toBe('https://example.org/z');
      expect(seen[0]?.request.method).toBe('GET');
    });
  });

  describe('XMLHttpRequest', () => {
    it('sends an allowed request', () => {
      const xhr = new env.FakeXhr();
      xhr.open('POST', '/api');
      xhr.send('hello');
      expect(env.calls.xhr).toEqual(['hello']);
      expect(seen[0]?.request.url?.href).toBe('https://chatgpt.com/api');
      expect(seen[0]?.transport).toBe('xhr');
    });

    it('does not send a blocked request and reports a network error', async () => {
      const xhr = new env.FakeXhr();
      const events: string[] = [];
      xhr.addEventListener('error', () => events.push('error'));
      xhr.addEventListener('loadend', () => events.push('loadend'));
      xhr.open('POST', '/api');
      xhr.send('a secret');
      expect(env.calls.xhr).toEqual([]);
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(events).toEqual(['error', 'loadend']);
    });

    it('reports a binary body as skipped', () => {
      const xhr = new env.FakeXhr();
      xhr.open('POST', '/upload');
      xhr.send(new Blob(['x']));
      expect(seen[0]?.request.body.skippedBinary).toBe(true);
      expect(env.calls.xhr).toHaveLength(1);
    });
  });

  describe('WebSocket', () => {
    it('sends an allowed message and drops a blocked one', () => {
      const socket = new env.FakeWebSocket();
      socket.send('hello');
      socket.send('a secret');
      expect(env.calls.ws).toEqual(['hello']);
      expect(seen[1]?.request.url?.href).toBe('wss://chatgpt.com/socket');
      expect(seen[1]?.transport).toBe('websocket');
    });
  });

  describe('sendBeacon', () => {
    it('sends an allowed beacon and returns its result', () => {
      const navigator = new env.FakeNavigator();
      expect(navigator.sendBeacon('/log', 'ok')).toBe(true);
      expect(env.calls.beacon).toEqual([['/log', 'ok']]);
    });

    it('returns false for a blocked beacon, without sending it', () => {
      const navigator = new env.FakeNavigator();
      expect(navigator.sendBeacon('/log?u=secret')).toBe(false);
      expect(env.calls.beacon).toEqual([]);
      expect(seen[0]?.transport).toBe('beacon');
    });
  });
});
