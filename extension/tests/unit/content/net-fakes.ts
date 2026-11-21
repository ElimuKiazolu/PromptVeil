import type { StandInMapping } from '@/src/core/restore/index.ts';
import type { CodecGlobals } from '@/src/net/body.ts';
import type { NetWindow } from '@/src/net/wrappers.ts';

/** A document as it is at document_start: no element besides the root. */
export function documentAtStart(): Document {
  const doc = document.implementation.createHTMLDocument('');
  doc.documentElement.replaceChildren();
  return doc;
}

/** The parser has created elements: page scripts may run from now on. */
export function pageScriptsMayRun(doc: Document): void {
  doc.documentElement.append(doc.createElement('head'));
}

// HMRC's tutorial NINO, masked: the net looks for its compact form.
export const NINO: StandInMapping = {
  standIn: 'TN 48 21 93 B',
  real: 'AB 12 34 56 C',
  boundary: 'word',
  netForms: ['ab123456c'],
};

/**
 * Page globals with fake transports that record what was sent. Body
 * reading uses the platform's own decoder, streams and decompression.
 */
export function fakeWindow() {
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
    setTimeout: (handler: () => void, ms?: number) => setTimeout(handler, ms),
    performance: { now: () => performance.now() },
    TextDecoder,
    Blob,
    Request,
    ReadableStream,
    DecompressionStream,
  };
  return {
    win: win as unknown as NetWindow &
      CodecGlobals & { performance: { now(): number } },
    sent,
    payloads,
    FakeXhr,
    FakeWebSocket,
    FakeNavigator,
  };
}
