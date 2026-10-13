import { createChatGptAdapter } from '@/src/adapters/chatgpt.ts';
import { startInstance } from '@/src/content/instance.ts';
import { createSpikeMasker } from '@/src/core/spike-mask.ts';
import { devlog } from '@/src/shared/devlog.ts';
import { isExtensionContextValid } from '@/src/shared/extension-context.ts';

export default defineContentScript({
  matches: ['https://chatgpt.com/*'],
  // Listen from the start so no send can slip through before the page settles.
  runAt: 'document_start',
  main(ctx) {
    devlog('instance.starting');
    const adapter = createChatGptAdapter();
    if (!adapter.matches(new URL(location.href))) return;

    const masker = createSpikeMasker();
    startInstance({
      adapter,
      transform: masker.transform,
      source: masker.source,
      isContextValid: isExtensionContextValid,
      signal: ctx.signal,
    });
  },
});
