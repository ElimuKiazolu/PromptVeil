import type { SiteAdapter } from '@/src/adapters/types.ts';
import { devlog } from '@/src/shared/devlog.ts';
import type { StandInSource } from '@/src/core/restore/index.ts';
import { installInterceptor, type PromptTransform } from './interceptor.ts';
import type { NetBridge } from './net-bridge.ts';
import { startRestorer } from './restorer.ts';
import { installSendGuard } from './send-guard.ts';
import { INSTANCE_STARTED_EVENT } from './send-events.ts';

export interface InstanceOptions {
  adapter: SiteAdapter;
  transform: PromptTransform;
  /** Stand-in mappings used to show real values in the conversation. */
  source: StandInSource;
  /** Channel to the request safety net; nothing is sent or shown without it. */
  net: NetBridge;
  /** Reads state private to this script's world (the extension runtime). */
  isContextValid: () => boolean;
  /** Aborted by the content-script framework when it invalidates us. */
  signal: AbortSignal;
  target?: Window;
  heartbeatMs?: number;
}

const DEFAULT_HEARTBEAT_MS = 2000;

/**
 * Runs one content-script instance: the send interceptor and the restorer
 * while the extension context is alive, and the block-only guard once it is
 * not (an orphan stops restoring too). Sending and restoring both require the
 * request safety net to be confirmed.
 *
 * Old and new instances do not share a world after an extension reload or
 * update, so the only way out of the guard is a page reload. Signals the page
 * can see or forge are only ever allowed to switch to the guard.
 */
export function startInstance({
  adapter,
  transform,
  source,
  net,
  isContextValid,
  signal,
  target = window,
  heartbeatMs = DEFAULT_HEARTBEAT_MS,
}: InstanceOptions): void {
  const controller = new AbortController();
  let stopped = false;

  // Detects an orphaned instance even when nobody sends anything.
  const heartbeat = setInterval(() => {
    if (!isContextValid()) stop('orphaned');
  }, heartbeatMs);

  const stop = (reason: 'orphaned' | 'superseded'): void => {
    if (stopped) return;
    stopped = true;
    controller.abort();
    clearInterval(heartbeat);
    devlog(reason === 'orphaned' ? 'instance.orphaned' : 'instance.superseded');
    installSendGuard(adapter, target);
  };

  installInterceptor({
    adapter,
    // The net learns every new mapping before the masked text is written
    // back, so no request can carry a masked value it does not know.
    transform: async (text) => {
      const masked = await transform(text);
      net.sync(source.mappings());
      return masked;
    },
    signal: controller.signal,
    isContextValid,
    onOrphaned: () => {
      stop('orphaned');
    },
    isNetReady: () => net.isReady(),
    target,
  });

  // Real values go back into the page only while the net guards requests.
  net.onReady(() => {
    if (stopped) return;
    startRestorer({
      adapter,
      source,
      signal: controller.signal,
      root: target.document.documentElement,
    });
  });

  signal.addEventListener(
    'abort',
    () => {
      stop(isContextValid() ? 'superseded' : 'orphaned');
    },
    { once: true },
  );

  // Retire if another instance starts in this tab, so at most one instance
  // ever intercepts. Our own announcement is ignored.
  let announcing = false;
  target.addEventListener(
    INSTANCE_STARTED_EVENT,
    () => {
      if (!announcing) stop('superseded');
    },
    { signal: controller.signal },
  );
  announcing = true;
  target.dispatchEvent(new Event(INSTANCE_STARTED_EVENT));
  announcing = false;

  if (signal.aborted) {
    stop(isContextValid() ? 'superseded' : 'orphaned');
    return;
  }
  devlog('instance.ready');
}
