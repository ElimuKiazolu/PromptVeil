import type { SiteAdapter } from '@/src/adapters/types.ts';
import { devlog } from '@/src/shared/devlog.ts';
import {
  INSTANCE_PING_EVENT,
  INSTANCE_READY_EVENT,
  SEND_EVENT_TYPES,
  isSendEvent,
} from './send-events.ts';

/**
 * Installed when the content script is invalidated (extension reloaded or
 * updated). Chrome does not re-inject into open tabs, so without this the
 * tab would send prompts unprotected until the page is reloaded.
 *
 * Uses only the DOM and the adapter: no extension APIs, which are gone once
 * the context is invalidated. It stays until the page is reloaded, or until
 * a live interceptor in this tab (a newer instance) announces itself.
 */
export function installSendGuard(
  adapter: SiteAdapter,
  target: Window = window,
): void {
  const block = (event: Event): void => {
    if (!isSendEvent(adapter, event)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    devlog('guard.blocked', 'context-invalidated');
  };
  const controller = new AbortController();
  const standDown = (): void => {
    controller.abort();
    devlog('guard.removed');
  };
  for (const type of SEND_EVENT_TYPES) {
    target.addEventListener(type, block, {
      capture: true,
      signal: controller.signal,
    });
  }
  target.addEventListener(INSTANCE_READY_EVENT, standDown, {
    once: true,
    signal: controller.signal,
  });
  devlog('guard.installed', 'context-invalidated');
  // A newer instance may already be running; it answers synchronously.
  target.dispatchEvent(new Event(INSTANCE_PING_EVENT));
}
