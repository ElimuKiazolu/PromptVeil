import type { NetTransport } from '@/src/shared/net-protocol.ts';
import { readBodySync, readFetchBody } from './body.ts';
import { parseRequestUrl, type DescribedRequest } from './request.ts';

/** The page globals the net wraps. */
export interface NetWindow {
  fetch: typeof fetch;
  XMLHttpRequest: { prototype: XMLHttpRequest };
  WebSocket: { prototype: WebSocket };
  Navigator: { prototype: Navigator };
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

type FetchFn = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;
type OpenFn = (this: XMLHttpRequest, ...args: unknown[]) => void;
type XhrSendFn = (
  this: XMLHttpRequest,
  body?: Document | XMLHttpRequestBodyInit | null,
) => void;
type WsSendFn = (
  this: WebSocket,
  data: string | ArrayBufferLike | Blob | ArrayBufferView,
) => void;
type BeaconFn = (
  this: Navigator,
  url: string | URL,
  data?: BodyInit | null,
) => boolean;

/**
 * Wraps fetch, XMLHttpRequest, WebSocket.send and navigator.sendBeacon so
 * every outgoing request passes `allow` first. Blocked requests fail the way
 * a network error would, so the page's own error handling takes over:
 * fetch rejects, XHR fires error, a WebSocket message is dropped, a beacon
 * returns false.
 */
export function wrapNetwork(win: NetWindow, allow: AllowRequest): void {
  const base = (): string => win.location.href;

  const originalFetch = originalFunction(win, 'fetch');
  const wrappedFetch: FetchFn = async (input, init) => {
    const raw =
      input instanceof Request
        ? input.url
        : input instanceof URL
          ? input.href
          : input;
    const request: DescribedRequest = {
      url: parseRequestUrl(raw, base()),
      method: init?.method ?? (input instanceof Request ? input.method : 'GET'),
      body: await readFetchBody(input, init),
    };
    if (!allow(request, 'fetch')) throw new TypeError('Failed to fetch');
    return originalFetch.call(win, input, init);
  };
  win.fetch = wrappedFetch;

  const ProgressEventCtor = win.ProgressEvent;
  const xhrProto = win.XMLHttpRequest.prototype;
  const originalOpen = originalFunction(xhrProto, 'open');
  const originalXhrSend = originalFunction(xhrProto, 'send');
  const opened = new WeakMap<XMLHttpRequest, { method: string; url: string }>();
  const wrappedOpen: OpenFn = function (this: XMLHttpRequest, ...args) {
    const [method, url] = args;
    opened.set(this, {
      method: typeof method === 'string' ? method : 'GET',
      url: url instanceof URL ? url.href : String(url),
    });
    Reflect.apply(originalOpen, this, args);
  };
  const wrappedXhrSend: XhrSendFn = function (this: XMLHttpRequest, body) {
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
      return;
    }
    originalXhrSend.call(this, body);
  };
  Reflect.set(xhrProto, 'open', wrappedOpen);
  Reflect.set(xhrProto, 'send', wrappedXhrSend);

  const wsProto = win.WebSocket.prototype;
  const originalWsSend = originalFunction(wsProto, 'send');
  const wrappedWsSend: WsSendFn = function (this: WebSocket, data) {
    const request: DescribedRequest = {
      url: parseRequestUrl(this.url, base()),
      method: 'SEND',
      body: readBodySync(data),
    };
    // A blocked message is dropped; closing the socket could make the page
    // reconnect and resend it.
    if (!allow(request, 'websocket')) return;
    originalWsSend.call(this, data);
  };
  Reflect.set(wsProto, 'send', wrappedWsSend);

  const navProto = win.Navigator.prototype;
  const originalBeacon = originalFunction(navProto, 'sendBeacon');
  const wrappedBeacon: BeaconFn = function (this: Navigator, url, data) {
    const request: DescribedRequest = {
      url: parseRequestUrl(url instanceof URL ? url.href : url, base()),
      method: 'POST',
      body: readBodySync(data),
    };
    if (!allow(request, 'beacon')) return false;
    return originalBeacon.call(this, url, data);
  };
  Reflect.set(navProto, 'sendBeacon', wrappedBeacon);
}
