import { createChatGptAdapter } from '@/src/adapters/chatgpt.ts';
import { installInterceptor } from '@/src/content/interceptor.ts';
import { installSendGuard } from '@/src/content/send-guard.ts';
import { createSpikeMasker } from '@/src/core/spike-mask.ts';

export default defineContentScript({
  matches: ['https://chatgpt.com/*'],
  // Listen from the start so no send can slip through before the page settles.
  runAt: 'document_start',
  main(ctx) {
    const adapter = createChatGptAdapter();
    if (!adapter.matches(new URL(location.href))) return;

    installInterceptor({
      adapter,
      transform: createSpikeMasker(),
      signal: ctx.signal,
    });
    ctx.onInvalidated(() => {
      installSendGuard(adapter);
    });
  },
});
