import { listenForNotices, type RuntimeLike } from '@/src/shared/messaging.ts';
import { isVaultNotice } from '@/src/shared/vault-protocol.ts';
import type { InstanceSession } from './instance.ts';
import { watchUrlChanges } from './url-watch.ts';
import type { VaultSession } from './vault-session.ts';

/**
 * Connects a vault session to the page: the conversation is re-read on every
 * URL change, and the service worker's notices (another tab's send,
 * auto-delete, delete-all) reach the session.
 */
export function vaultLifecycle(
  session: VaultSession,
  runtime: RuntimeLike,
  target: Window = window,
): InstanceSession {
  return {
    start(signal) {
      session.checkConversation();
      watchUrlChanges({
        onChange: () => {
          session.checkConversation();
        },
        signal,
        target,
      });
      const stopListening = listenForNotices(
        runtime,
        isVaultNotice,
        (notice) => {
          session.handleNotice(notice);
        },
      );
      signal.addEventListener('abort', stopListening, { once: true });
    },
    clear: () => {
      session.clear();
    },
    resume: () => {
      session.resume();
    },
    dispose: () => {
      session.dispose();
    },
  };
}
