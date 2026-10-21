import { createChatGptAdapter } from '@/src/adapters/chatgpt.ts';
import { startInstance } from '@/src/content/instance.ts';
import { startNetBridge } from '@/src/content/net-bridge.ts';
import { createMainThreadYielder } from '@/src/content/yielder.ts';
import {
  clearRuleCaches,
  rulesAnalysis,
  warmUpRules,
} from '@/src/core/detect/rules/analysis.ts';
import {
  COUNTRY_PACKS,
  enabledPacks,
} from '@/src/core/detect/rules/packs/index.ts';
import { createCheckpoint } from '@/src/core/detect/schedule.ts';
import { createDraftAnalyzer } from '@/src/core/draft/analyzer.ts';
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

/** Longest wait for an idle period before warming up anyway. */
const WARM_UP_TIMEOUT_MS = 2000;

/** Runs `task` when the page is idle (or after the timeout). */
function whenIdle(task: () => void): void {
  if (typeof requestIdleCallback === 'function') {
    requestIdleCallback(task, { timeout: WARM_UP_TIMEOUT_MS });
  } else {
    setTimeout(task, WARM_UP_TIMEOUT_MS);
  }
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
    const homeRegions = regionsFromLanguages(navigator.languages);
    const yielder = createMainThreadYielder();
    const analyzer = createDraftAnalyzer({
      analyse: rulesAnalysis({
        homeRegions,
        entityTypes: SPIKE_ENTITY_TYPES,
        packs: enabledPacks(COUNTRY_PACKS, DEFAULT_SETTINGS.idPacks),
      }),
      yielder,
      onClear: clearRuleCaches,
    });
    const masker = createSpikeMasker({
      sessionTag: randomSessionTag(),
      detect: (text) => analyzer.analyse(text),
    });
    startInstance({
      adapter,
      transform: masker.transform,
      source: masker.source,
      net,
      isContextValid: isExtensionContextValid,
      signal: ctx.signal,
      draft: {
        prepare: (text) => analyzer.prepare(text),
        clear: () => {
          analyzer.clear();
        },
        dispose: () => {
          analyzer.dispose();
          yielder.close();
        },
      },
    });

    // The first all-region phone check compiles libphonenumber's patterns;
    // do that at idle, in slices, rather than during the first Send.
    whenIdle(() => {
      if (ctx.signal.aborted) return;
      warmUpRules(createCheckpoint(yielder, { signal: ctx.signal })).then(
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
