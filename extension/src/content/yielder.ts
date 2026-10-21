import type { Yielder } from '@/src/core/detect/schedule.ts';

export interface MainThreadYielder extends Yielder {
  /** Releases the channel; later yields resolve at once. */
  close(): void;
}

/**
 * Yields to the event loop through a MessageChannel: the continuation runs in
 * a new task (input and rendering can happen in between) without the 4 ms
 * minimum delay that nested setTimeout calls get.
 */
export function createMainThreadYielder(): MainThreadYielder {
  const channel = new MessageChannel();
  const waiting: (() => void)[] = [];
  let closed = false;
  channel.port1.onmessage = () => {
    waiting.shift()?.();
  };
  return {
    now: () => performance.now(),
    yieldNow() {
      if (closed) return Promise.resolve();
      return new Promise<void>((resolve) => {
        waiting.push(resolve);
        channel.port2.postMessage(null);
      });
    },
    close() {
      closed = true;
      channel.port1.close();
      channel.port2.close();
      for (const resolve of waiting.splice(0)) resolve();
    },
  };
}
