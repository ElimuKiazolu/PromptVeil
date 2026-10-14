import { createChatGptAdapter } from '@/src/adapters/chatgpt.ts';
import { startInstance } from '@/src/content/instance.ts';
import { startNetBridge } from '@/src/content/net-bridge.ts';
import { createSpikeMasker } from '@/src/core/spike-mask.ts';
import { devlog } from '@/src/shared/devlog.ts';
import { isExtensionContextValid } from '@/src/shared/extension-context.ts';

/** Four random base-36 characters, distinct per page load. */
function randomSessionTag(): string {
  const [value = 0] = crypto.getRandomValues(new Uint32Array(1));
  return (value % 36 ** 4).toString(36).padStart(4, '0');
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

    const masker = createSpikeMasker({ sessionTag: randomSessionTag() });
    startInstance({
      adapter,
      transform: masker.transform,
      source: masker.source,
      net,
      isContextValid: isExtensionContextValid,
      signal: ctx.signal,
    });
  },
});
