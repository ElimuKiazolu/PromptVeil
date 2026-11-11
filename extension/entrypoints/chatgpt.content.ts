import { createChatGptAdapter } from '@/src/adapters/chatgpt.ts';
import { createLazyDetection } from '@/src/content/detection-loader.ts';
import { startInstance } from '@/src/content/instance.ts';
import { startNetBridge } from '@/src/content/net-bridge.ts';
import { vaultLifecycle } from '@/src/content/vault-lifecycle.ts';
import { createVaultSession } from '@/src/content/vault-session.ts';
import { createMainThreadYielder } from '@/src/content/yielder.ts';
import { createCheckpoint } from '@/src/core/detect/schedule.ts';
import { LIVE_ENTITY_TYPES, createMasker } from '@/src/core/masker.ts';
import { regionsFromLanguages } from '@/src/shared/country.ts';
import { devlog } from '@/src/shared/devlog.ts';
import { isExtensionContextValid } from '@/src/shared/extension-context.ts';
import { createMessenger, PROTOCOL } from '@/src/shared/messaging.ts';
import { DEFAULT_SETTINGS } from '@/src/shared/settings.ts';

/** Longest wait for an idle period before loading detection anyway. */
const IDLE_TIMEOUT_MS = 2000;

/** Runs `task` when the page is idle (or after the timeout). */
function whenIdle(task: () => void): void {
  if (typeof requestIdleCallback === 'function') {
    requestIdleCallback(task, { timeout: IDLE_TIMEOUT_MS });
  } else {
    setTimeout(task, IDLE_TIMEOUT_MS);
  }
}

/**
 * The detection module (detector, phone metadata, country packs), built
 * apart from this script and listed as a web-accessible resource with a
 * per-session URL. Loading it after the page has started keeps document_start
 * light.
 */
function importDetectionModule(): Promise<unknown> {
  const url = browser.runtime.getURL('/detection.js');
  return import(/* @vite-ignore */ url);
}

export default defineContentScript({
  matches: ['https://chatgpt.com/*'],
  // Listen from the start so no send can slip through before the page settles.
  runAt: 'document_start',
  main(ctx) {
    // First, while the handshake with the request safety net is possible.
    const net = startNetBridge();
    devlog('instance.starting');
    const adapter = createChatGptAdapter();
    if (!adapter.matches(new URL(location.href))) return;

    // Until onboarding (P10) stores home regions, they come from the
    // browser's language list.
    const languageRegions = regionsFromLanguages(navigator.languages);
    const yielder = createMainThreadYielder();
    const detection = createLazyDetection({
      load: importDetectionModule,
      create: (module) =>
        module.createDetection(
          {
            homeRegions: languageRegions,
            preferredRegions: languageRegions,
            entityTypes: LIVE_ENTITY_TYPES,
            idPacks: DEFAULT_SETTINGS.idPacks,
          },
          yielder,
        ),
    });
    // The service worker keeps the mappings; this tab holds the current
    // conversation's in memory while the page shows it.
    const session = createVaultSession({
      adapter,
      messenger: createMessenger(PROTOCOL, browser.runtime),
      beforePublish: (mappings) => {
        net.sync(mappings);
      },
      randomUUID: () => crypto.randomUUID(),
    });
    const masker = createMasker({
      // A Send before the module is ready waits for it; if it cannot load,
      // the transform rejects and the Send is blocked.
      detect: async (text) => (await detection.ready()).analyse(text),
      normalise: async (found) => (await detection.ready()).normalise(found),
      engine: async () => {
        const runtime = await detection.ready();
        return (request, seed, attempt) =>
          runtime.standIn(request, seed, attempt);
      },
      // Any vault failure rejects, and the Send is blocked.
      mask: (items, issue) => session.mask(items, issue),
      isIssued: (value) => session.isIssued(value),
      entityTypes: LIVE_ENTITY_TYPES,
    });
    startInstance({
      adapter,
      transform: masker.transform,
      source: session.source,
      session: vaultLifecycle(session, browser.runtime),
      net,
      isContextValid: isExtensionContextValid,
      signal: ctx.signal,
      draft: {
        prepare: async (text) => {
          await (await detection.ready()).prepare(text);
        },
        clear: () => {
          detection.current()?.clear();
        },
        dispose: () => {
          detection.dispose();
          yielder.close();
        },
      },
    });

    // At idle: load the module, then build its lookup tables in slices, so
    // neither the page's start nor the first Send pays for them.
    whenIdle(() => {
      if (ctx.signal.aborted) return;
      detection.start();
      detection
        .ready()
        .then((runtime) =>
          runtime.warmUp(createCheckpoint(yielder, { signal: ctx.signal })),
        )
        .then(
          () => {
            devlog('warmup.done');
          },
          (error: unknown) => {
            devlog('warmup.failed', { error });
          },
        );
    });
  },
});
