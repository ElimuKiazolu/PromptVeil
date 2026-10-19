/**
 * Benchmark builds only: the service worker owns the offscreen document
 * (TR-N1), as the production NER host will. The benchmark page asks for it
 * over a port and gets a ready or error reply.
 */
import {
  BENCH_OFFSCREEN_PORT,
  errorMessage,
  type OffscreenReply,
} from './protocol.ts';
import { offscreenUrl } from './session.ts';

let creating: Promise<boolean> | null = null;

/** Resolves true if this call created the document, false if it already existed. */
async function ensureOffscreen(): Promise<boolean> {
  const url = offscreenUrl(browser.runtime.getURL('/'));
  const existing = await browser.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [url],
  });
  if (existing.length > 0) return false;
  await browser.offscreen.createDocument({
    url,
    reasons: ['WORKERS'],
    justification: 'Development-only timing of the on-device NER model.',
  });
  return true;
}

export function startBenchOffscreenHost(): void {
  browser.runtime.onConnect.addListener((port) => {
    if (port.name !== BENCH_OFFSCREEN_PORT) return;
    // The page may close or reload before the reply; then nobody is waiting.
    let open = true;
    port.onDisconnect.addListener(() => {
      open = false;
    });
    const reply = (message: OffscreenReply): void => {
      if (open) port.postMessage(message);
    };
    // Concurrent requests share one creation: a second createDocument call
    // would fail because only one offscreen document may exist.
    creating ??= ensureOffscreen().finally(() => {
      creating = null;
    });
    creating.then(
      (created) => {
        reply({ type: 'offscreen-ready', created });
      },
      (error: unknown) => {
        reply({ type: 'error', message: errorMessage(error) });
      },
    );
  });
}
