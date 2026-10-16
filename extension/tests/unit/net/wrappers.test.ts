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
    navigator: new FakeNavigator(),
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

  describe('when the page redefines a function after us', () => {
    const pageNavigator = () =>
      (env.win as unknown as { navigator: Navigator }).navigator;

    it('keeps checking a beacon after the page assigns its own function', () => {
      const replaced: unknown[] = [];
      // A library replaces sendBeacon on the navigator object.
      pageNavigator().sendBeacon = function (url, data) {
        replaced.push([url, data]);
        return true;
      };
      expect(pageNavigator().sendBeacon('/log', 'a secret')).toBe(false);
      expect(pageNavigator().sendBeacon('/log', 'fine')).toBe(true);
      expect(replaced).toEqual([['/log', 'fine']]);
    });

    it('keeps checking after the page replaces the prototype function', () => {
      const replaced: unknown[] = [];
      env.FakeNavigator.prototype.sendBeacon = function (url, data) {
        replaced.push([url, data]);
        return true;
      };
      const other = new env.FakeNavigator();
      expect(other.sendBeacon('/log', 'a secret')).toBe(false);
      expect(replaced).toEqual([]);
    });

    it('still guards a function called through the prototype', () => {
      expect(
        env.FakeNavigator.prototype.sendBeacon.call(
          pageNavigator(),
          '/log',
          'a secret',
        ),
      ).toBe(false);
      expect(env.calls.beacon).toEqual([]);
    });

    it('cannot be redefined with defineProperty', () => {
      expect(() =>
        Object.defineProperty(pageNavigator(), 'sendBeacon', {
          value: () => true,
        }),
      ).toThrow(TypeError);
      expect(() =>
        Object.defineProperty(env.win, 'fetch', {
          value: () => Promise.resolve(new Response()),
        }),
      ).toThrow(TypeError);
      expect(pageNavigator().sendBeacon('/log', 'a secret')).toBe(false);
    });

    it('keeps checking fetch after the page restores a "native" function', async () => {
      const restored: unknown[] = [];
      env.win.fetch = (input) => {
        restored.push(input);
        return Promise.resolve(new Response('restored'));
      };
      await expect(
        env.win.fetch('/x', { method: 'POST', body: 'a secret' }),
      ).rejects.toThrow(TypeError);
      expect(restored).toEqual([]);
      expect(await (await env.win.fetch('/y')).text()).toBe('restored');
    });

    it('lets a library wrap ours without loops, checking each request', async () => {
      // The usual wrapping pattern: keep the current function, replace it
      // with one that calls through.
      const previous = env.win.fetch.bind(env.win);
      let wrapperCalls = 0;
      env.win.fetch = (input, init) => {
        wrapperCalls += 1;
        return previous(input, init);
      };
      await env.win.fetch('/ok');
      expect(wrapperCalls).toBe(1);
      expect(env.calls.fetch).toHaveLength(1);
      await expect(env.win.fetch('/x?q=secret')).rejects.toThrow(TypeError);
      expect(env.calls.fetch).toHaveLength(1);
    });

    it('keeps checking XHR and WebSocket after prototype replacement', () => {
      const xhrSends: unknown[] = [];
      const wsSends: unknown[] = [];
      env.FakeXhr.prototype.send = function (body?: unknown) {
        xhrSends.push(body);
      };
      env.FakeWebSocket.prototype.send = function (data: unknown) {
        wsSends.push(data);
      };
      const xhr = new env.FakeXhr();
      xhr.open('POST', '/api');
      xhr.send('a secret');
      new env.FakeWebSocket().send('a secret');
      expect(xhrSends).toEqual([]);
      expect(wsSends).toEqual([]);
    });

    it('returns the same guarded function each time', () => {
      const read = (owner: object, name: string): unknown =>
        Reflect.get(owner, name) as unknown;
      expect(read(env.win, 'fetch')).toBe(read(env.win, 'fetch'));
      expect(read(env.FakeXhr.prototype, 'send')).toBe(
        read(env.FakeXhr.prototype, 'send'),
      );
    });

    it('ignores assignments that are not functions', async () => {
      Reflect.set(env.win, 'fetch', undefined);
      await expect(env.win.fetch('/x?q=secret')).rejects.toThrow(TypeError);
    });
  });
});
