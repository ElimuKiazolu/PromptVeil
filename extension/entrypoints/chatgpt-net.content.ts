import { chatgptNetRules } from '@/src/adapters/chatgpt.ts';
import { installNetGuard } from '@/src/net/guard.ts';

/**
 * Request safety net, in the page's own world so it sees the page's
 * requests. Runs at document_start, before any page script.
 */
export default defineContentScript({
  matches: ['https://chatgpt.com/*'],
  runAt: 'document_start',
  world: 'MAIN',
  main() {
    installNetGuard(window, document, chatgptNetRules);
  },
});
