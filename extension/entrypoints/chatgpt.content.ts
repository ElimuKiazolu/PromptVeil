import { createChatGptAdapter } from '@/src/adapters/chatgpt.ts';
import { createLazyDetection } from '@/src/content/detection-loader.ts';
import { startInstance } from '@/src/content/instance.ts';
import { startNetBridge } from '@/src/content/net-bridge.ts';
import { createMainThreadYielder } from '@/src/content/yielder.ts';
import { createCheckpoint } from '@/src/core/detect/schedule.ts';
import {
  SPIKE_ENTITY_TYPES,
  createSpikeMasker,
} from '@/src/core/spike-mask.ts';
import { regionsFromLanguages } from '@/src/shared/country.ts';
import { devlog } from '@/src/shared/devlog.ts';
import { isExtensionContextValid } from '@/src/shared/extension-context.ts';
import { DEFAULT_SETTINGS } from '@/src/shared/settings.ts';

/** Four random base-36 characters, distinct per page load. */
function randomSessionTag(): string {
  const [value = 0] = crypto.getRandomValues(new Uint32Array(1));
  return (value % 36 ** 4).toString(36).padStart(4, '0');
}

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
            entityTypes: SPIKE_ENTITY_TYPES,
            idPacks: DEFAULT_SETTINGS.idPacks,
          },
          yielder,
        ),
    });
    const masker = createSpikeMasker({
      sessionTag: randomSessionTag(),
      // A Send before the module is ready waits for it; if it cannot load,
      // the transform rejects and the Send is blocked.
      detect: async (text) => (await detection.ready()).analyse(text),
    });
    startInstance({
      adapter,
      transform: masker.transform,
      source: masker.source,
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
