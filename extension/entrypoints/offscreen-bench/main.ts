/**
 * Dev-only offscreen document (TR-N1): hosts the benchmark worker and relays
 * between it and the benchmark page. A fresh worker per run, so every run
 * measures a cold model load.
 */
import {
  BENCH_PORT,
  type BenchConfig,
  type BenchMessage,
  type WorkerRunRequest,
} from '@/src/dev/bench/protocol.ts';
import { benchTexts } from '@/src/dev/bench/texts.ts';

interface MemoryMeasurement {
  bytes: number;
}

/** Page + workers memory where the browser offers it (cross-origin isolated). */
async function measureMemory(): Promise<number | null> {
  const measure: unknown = Reflect.get(
    performance,
    'measureUserAgentSpecificMemory',
  );
  if (!self.crossOriginIsolated || typeof measure !== 'function') return null;
  const result = (await Reflect.apply(
    measure,
    performance,
    [],
  )) as MemoryMeasurement;
  return result.bytes;
}

browser.runtime.onConnect.addListener((port) => {
  if (port.name !== BENCH_PORT) return;
  port.onMessage.addListener((config: BenchConfig) => {
    const worker = new Worker(
      new URL('../../src/dev/bench/worker.ts', import.meta.url),
      { type: 'module' },
    );
    worker.addEventListener('message', (event: MessageEvent<BenchMessage>) => {
      const message = event.data;
      if (message.type !== 'result') {
        port.postMessage(message);
        if (message.type === 'error') worker.terminate();
        return;
      }
      void measureMemory().then((memoryBytes) => {
        port.postMessage({
          type: 'result',
          result: { ...message.result, memoryBytes },
        } satisfies BenchMessage);
        worker.terminate();
      });
    });
    const request: WorkerRunRequest = {
      type: 'run',
      config,
      // Directories inside the extension, resolved from this page's URL.
      modelBase: new URL('/models/', location.href).href,
      wasmBase: new URL('/ort/', location.href).href,
      texts: benchTexts(),
    };
    worker.postMessage(request);
  });
});
