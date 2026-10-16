import type { NetTransport } from '@/src/shared/net-protocol.ts';
import { readBodySync, readFetchBody } from './body.ts';
import { parseRequestUrl, type DescribedRequest } from './request.ts';

/** The page globals the net wraps. */
export interface NetWindow {
  fetch: typeof fetch;
  XMLHttpRequest: { prototype: XMLHttpRequest };
  WebSocket: { prototype: WebSocket };
  Navigator: { prototype: Navigator };
  navigator: Navigator;
  ProgressEvent: new (type: string) => Event;
  location: { href: string };
  setTimeout: (handler: () => void, timeout?: number) => unknown;
}

/** Decides whether a request may go out; false blocks it. */
export type AllowRequest = (
  request: DescribedRequest,
  transport: NetTransport,
) => boolean;

/** The current value of a function property, captured before the page runs. */
export function originalFunction<O extends object, K extends keyof O & string>(
  owner: O,
  name: K,
): O[K] {
  const value: unknown = Reflect.get(owner, name);
  if (typeof value !== 'function') {
    throw new TypeError(`${name} is not a function`);
  }
  return value as O[K];
}

/** Any function: every function type is assignable to this one. */
type Callable = (this: never, ...args: never[]) => unknown;

/** Puts a guard in front of one implementation. */
type MakeGuard = (impl: Callable) => Callable;

/**
 * Turns a function property into a non-configurable accessor, so the guard
 * cannot be silently removed by code that runs later:
 * - reading returns the guard in front of the current implementation (the
 *   same function object each time for the same implementation);
 * - assigning, as libraries do to wrap or "restore" a function, replaces the
 *   implementation, and the guard stays in front of it;
 * - assigning on an instance gives that instance its own guarded accessor.
 * Redefining the property with Object.defineProperty throws.
 */
function installGuard(
  owner: object,
  name: string,
  makeGuard: MakeGuard,
  initial?: Callable,
): void {
  const current: unknown = initial ?? Reflect.get(owner, name);
  if (typeof current !== 'function') {
    throw new TypeError(`${name} is not a function`);
  }
  let impl = current as Callable;
  const guards = new WeakMap<Callable, Callable>();
  const guarded = (fn: Callable): Callable => {
    let guard = guards.get(fn);
    if (!guard) {
      guard = makeGuard(fn);
      guards.set(fn, guard);
    }
    return guard;
  };

  Object.defineProperty(owner, name, {
    configurable: false,
    enumerable:
      Object.getOwnPropertyDescriptor(owner, name)?.enumerable ?? true,
    get: () => guarded(impl),
    set(this: unknown, value: unknown) {
      // Only functions replace the implementation; anything else is ignored,
      // which keeps the guarded function in place.
      if (typeof value !== 'function') return;
      if (this === owner) {
        impl = value as Callable;
      } else if (typeof this === 'object' && this !== null) {
        installGuard(this, name, makeGuard, value as Callable);
      }
    },
  });
}

/**
 * Wraps fetch, XMLHttpRequest, WebSocket.send and navigator.sendBeacon so
 * every outgoing request passes `allow` first. Blocked requests fail the way
 * a network error would, so the page's own error handling takes over:
 * fetch rejects, XHR fires error, a WebSocket message is dropped, a beacon
 * returns false.
 */
export function wrapNetwork(win: NetWindow, allow: AllowRequest): void {
  const base = (): string => win.location.href;

  installGuard(
    win,
    'fetch',
    (impl) =>
      async function guardedFetch(
        this: unknown,
        input: RequestInfo | URL,
        init?: RequestInit,
      ): Promise<Response> {
        const raw =
          input instanceof Request
            ? input.url
            : input instanceof URL
              ? input.href
              : input;
        const request: DescribedRequest = {
          url: parseRequestUrl(raw, base()),
          method:
            init?.method ?? (input instanceof Request ? input.method : 'GET'),
          body: await readFetchBody(input, init),
        };
        if (!allow(request, 'fetch')) throw new TypeError('Failed to fetch');
        return Reflect.apply(impl, this ?? win, [
          input,
          init,
        ]) as Promise<Response>;
      },
  );

  const ProgressEventCtor = win.ProgressEvent;
  const xhrProto = win.XMLHttpRequest.prototype;
  const opened = new WeakMap<XMLHttpRequest, { method: string; url: string }>();
  installGuard(
    xhrProto,
    'open',
    (impl) =>
      function guardedOpen(this: XMLHttpRequest, ...args: unknown[]): unknown {
        const [method, url] = args;
        opened.set(this, {
          method: typeof method === 'string' ? method : 'GET',
          url: url instanceof URL ? url.href : String(url),
        });
        return Reflect.apply(impl, this, args) as unknown;
      },
  );
  installGuard(
    xhrProto,
    'send',
    (impl) =>
      function guardedXhrSend(
        this: XMLHttpRequest,
        body?: Document | XMLHttpRequestBodyInit | null,
      ): unknown {
        const target = opened.get(this);
        const request: DescribedRequest = {
          url: target ? parseRequestUrl(target.url, base()) : null,
          method: target?.method ?? 'GET',
          body: readBodySync(body),
        };
        if (!allow(request, 'xhr')) {
          // Report it the way a network failure would be reported.
          win.setTimeout(() => {
            this.dispatchEvent(new ProgressEventCtor('error'));
            this.dispatchEvent(new ProgressEventCtor('loadend'));
          }, 0);
          return undefined;
        }
        return Reflect.apply(impl, this, [body]) as unknown;
      },
  );

  installGuard(
    win.WebSocket.prototype,
    'send',
    (impl) =>
      function guardedWsSend(
        this: WebSocket,
        data: string | ArrayBufferLike | Blob | ArrayBufferView,
      ): unknown {
        const request: DescribedRequest = {
          url: parseRequestUrl(this.url, base()),
          method: 'SEND',
          body: readBodySync(data),
        };
        // A blocked message is dropped; closing the socket could make the page
        // reconnect and resend it.
        if (!allow(request, 'websocket')) return undefined;
        return Reflect.apply(impl, this, [data]) as unknown;
      },
  );

  const beaconGuard: MakeGuard = (impl) =>
    function guardedBeacon(
      this: unknown,
      url: string | URL,
      data?: BodyInit | null,
    ): boolean {
      const request: DescribedRequest = {
        url: parseRequestUrl(url instanceof URL ? url.href : url, base()),
        method: 'POST',
        body: readBodySync(data),
      };
      if (!allow(request, 'beacon')) return false;
      return Reflect.apply(impl, this ?? win.navigator, [url, data]) === true;
    };
  const nativeBeacon = originalFunction(win.Navigator.prototype, 'sendBeacon');
  installGuard(win.Navigator.prototype, 'sendBeacon', beaconGuard);
  // The navigator object gets its own guarded property too, so a later
  // defineProperty on it cannot add an unguarded one.
  installGuard(win.navigator, 'sendBeacon', beaconGuard, nativeBeacon);
}
