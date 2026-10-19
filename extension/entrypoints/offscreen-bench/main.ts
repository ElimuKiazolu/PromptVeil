/**
 * Dev-only offscreen document (TR-N1): hosts the benchmark worker and relays
 * its messages to the benchmark page. One port per run and a fresh worker per
 * run, so every run measures a cold model load. Failures, including a worker
 * that cannot start, are sent to the page with their stage.
 */
import {
  BENCH_PORT,
  errorMessage,
  isWorkerRunRequest,
  type BenchMessage,
} from '@/src/dev/bench/protocol.ts';
import {
  measureMemory,
  workerChannel,
  type BenchChannel,
} from '@/src/dev/bench/session.ts';

browser.runtime.onConnect.addListener((port) => {
  if (port.name !== BENCH_PORT) return;
  let open = true;
  let channel: BenchChannel | null = null;
  const send = (message: BenchMessage): void => {
    if (open) port.postMessage(message);
  };
  port.onDisconnect.addListener(() => {
    open = false;
    channel?.close();
  });
  port.onMessage.addListener((message: unknown) => {
    if (channel !== null || !isWorkerRunRequest(message)) {
      send({
        type: 'error',
        stage: 'starting-worker',
        message: 'the offscreen document received an unexpected message',
      });
      return;
    }
    try {
      channel = workerChannel(
        new Worker(new URL('../../src/dev/bench/worker.ts', import.meta.url), {
          type: 'module',
        }),
        send,
        measureMemory,
      );
      channel.send(message);
    } catch (error) {
      send({
        type: 'error',
        stage: 'starting-worker',
        message: errorMessage(error),
      });
    }
  });
});
