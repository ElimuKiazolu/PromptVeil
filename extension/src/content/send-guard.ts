import type { SiteAdapter } from '@/src/adapters/types.ts';
import { devlog } from '@/src/shared/devlog.ts';
import { SEND_EVENT_TYPES, isSendEvent } from './send-events.ts';

/**
 * Block-only fallback for a tab whose instance can no longer protect sends:
 * the extension was reloaded or updated (the instance is orphaned), or a
 * newer instance started in the same tab.
 *
 * It blocks every send, trusted or synthetic, until the page is reloaded.
 * Nothing can remove it: an orphan cannot tell a real new instance from a
 * page script pretending to be one, since they do not share a world.
 * It uses only the DOM and the adapter, never extension APIs.
 */
export function installSendGuard(
  adapter: SiteAdapter,
  target: Window = window,
): void {
  const block = (event: Event): void => {
    if (!isSendEvent(adapter, event)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    devlog('guard.blocked', { reason: 'context-invalidated' });
  };
  for (const type of SEND_EVENT_TYPES) {
    target.addEventListener(type, block, { capture: true });
  }
  devlog('guard.installed', { reason: 'context-invalidated' });
}
