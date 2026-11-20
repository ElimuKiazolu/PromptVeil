import { createChatGptAdapter } from '@/src/adapters/chatgpt.ts';
import { createLazyDetection } from '@/src/content/detection-loader.ts';
import { startInstance } from '@/src/content/instance.ts';
import { startNetBridge } from '@/src/content/net-bridge.ts';
import {
  DEFAULT_PIPELINE_SETTINGS,
  effectiveHomeRegions,
  watchSettings,
  type PipelineSettings,
} from '@/src/content/settings.ts';
import { vaultLifecycle } from '@/src/content/vault-lifecycle.ts';
import { createVaultSession } from '@/src/content/vault-session.ts';
import { loadWordList } from '@/src/content/word-lists.ts';
import { createMainThreadYielder } from '@/src/content/yielder.ts';
import { createCheckpoint } from '@/src/core/detect/schedule.ts';
import type { DetectionConfig } from '@/src/core/detect/bundle.ts';
import { createPipeline, needsMasking } from '@/src/core/pipeline.ts';
import {
  regionsFromLanguages,
  type CountryCode,
} from '@/src/shared/country.ts';
import { devlog } from '@/src/shared/devlog.ts';
import { isExtensionContextValid } from '@/src/shared/extension-context.ts';
import { createMessenger, PROTOCOL } from '@/src/shared/messaging.ts';

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
    const settings = watchSettings(
      browser.storage.local,
      browser.storage.onChanged,
    );
    let current: PipelineSettings = DEFAULT_PIPELINE_SETTINGS;
    const detectionConfig = (
      from: PipelineSettings,
      regions: readonly CountryCode[],
    ): DetectionConfig => ({
      homeRegions: effectiveHomeRegions(from, regions),
      preferredRegions: regions,
      entityTypes: from.entityTypes,
      idPacks: from.idPacks,
      keepCity: from.keepCity,
      maskPrivateIps: from.maskPrivateIps,
    });
    const detection = createLazyDetection({
      // The module is set up with the stored settings, so it waits for them.
      load: async () => {
        current = await settings.ready();
        return importDetectionModule();
      },
      create: (module) =>
        module.createDetection(
          detectionConfig(current, languageRegions),
          yielder,
          loadWordList,
        ),
    });
    settings.subscribe((next) => {
      current = next;
      detection.current()?.configure(detectionConfig(next, languageRegions));
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
    const pipeline = createPipeline({
      // A Send before the module is ready waits for it; if it cannot load,
      // the transform rejects and the Send is blocked.
      detect: async (text) => (await detection.ready()).analyse(text),
      normalise: async (found) => (await detection.ready()).normalise(found),
      engine: async () => {
        const runtime = await detection.ready();
        return {
          load: (requests) => runtime.loadWords(requests),
          standIn: (request, seed, attempt) =>
            runtime.standIn(request, seed, attempt),
        };
      },
      // Any vault failure rejects, and the Send is blocked.
      mask: (items, issue) => session.mask(items, issue),
      isIssued: (value) => session.isIssued(value),
      issued: () => session.issued(),
      peek: (items) => session.peek(items),
      entityTypes: () => current.entityTypes,
      checkpoint: () => createCheckpoint(yielder, { signal: ctx.signal }),
      clock: () => performance.now(),
      report: ({
        timings,
        masked,
        possible,
        ambiguousDates,
        cardFallbacks,
        nextReadings,
      }) => {
        devlog('pipeline.timing', { count: masked, timings });
        // Not masked until the Review panel (P9); counted only.
        if (possible > 0) devlog('pipeline.possible', { count: possible });
        // Day and month read in the home region's order (counts only).
        if (ambiguousDates > 0) {
          devlog('pipeline.ambiguous-dates', { count: ambiguousDates });
        }
        // Card stand-ins taken from a related brand's test numbers.
        if (cardFallbacks > 0) {
          devlog('pipeline.card-fallback', { count: cardFallbacks });
        }
        // Masked in their span's next reading (the first had no stand-in).
        if (nextReadings > 0) {
          devlog('pipeline.next-reading', { count: nextReadings });
        }
      },
    });
    // Message requests sent with fetch: the net asks whether their text
    // holds a value a send would have masked.
    net.setVerifier(async (texts) => {
      // Waits for the module like a send does; a load failure blocks.
      const runtime = await detection.ready();
      for (const text of texts) {
        const detections = await runtime.analyse(text);
        const unmasked = detections.some((found) =>
          needsMasking(found, current.entityTypes, (value) =>
            session.isIssued(value),
          ),
        );
        if (unmasked) return true;
      }
      return false;
    });
    startInstance({
      adapter,
      transform: pipeline.transform,
      source: session.source,
      session: vaultLifecycle(session, browser.runtime),
      net,
      isContextValid: isExtensionContextValid,
      signal: ctx.signal,
      draft: {
        prepare: async (text) => {
          await (await detection.ready()).prepare(text);
          // The vault lookup a Send of this draft needs, done ahead.
          await pipeline.prepare(text);
        },
        clear: () => {
          detection.current()?.clear();
        },
        dispose: () => {
          settings.dispose();
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
