/**
 * Dev-only benchmark worker: loads the NER model with Transformers.js from
 * the extension's own files and times it. Remote model loading is disabled.
 */
import { env, pipeline } from '@huggingface/transformers';
import { countEntities, type TokenEntity } from './entities.ts';
import {
  MODEL_ID,
  WARM_RUNS,
  type BenchMessage,
  type BenchResult,
  type WorkerRunRequest,
} from './protocol.ts';
import { summarise } from './stats.ts';
import { BENCH_WORD_TARGETS } from './texts.ts';

const post = (message: BenchMessage): void => {
  self.postMessage(message);
};

function isTokenEntity(value: unknown): value is TokenEntity {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { entity?: unknown }).entity === 'string' &&
    typeof (value as { index?: unknown }).index === 'number'
  );
}

async function run(
  request: WorkerRunRequest,
): Promise<Omit<BenchResult, 'memoryBytes'>> {
  env.allowRemoteModels = false;
  env.allowLocalModels = true;
  env.localModelPath = request.modelBase;
  env.useBrowserCache = false;
  const wasm = env.backends.onnx.wasm;
  if (wasm) {
    wasm.wasmPaths = request.wasmBase;
    wasm.numThreads = request.config.threads;
  }

  post({ type: 'progress', step: `loading model (${request.config.device})` });
  const loadStart = performance.now();
  const classify = await pipeline('token-classification', MODEL_ID, {
    dtype: 'q8',
    device: request.config.device,
  });
  const loadMs = performance.now() - loadStart;

  const timings = {} as BenchResult['timings'];
  let entities300: Record<string, number> = {};
  for (const size of BENCH_WORD_TARGETS) {
    const text = request.texts[size];
    post({ type: 'progress', step: `${size.toString()} words: warm-up` });
    const output: unknown = await classify(text);
    if (size === 300) {
      const tokens = Array.isArray(output) ? output.filter(isTokenEntity) : [];
      entities300 = countEntities(tokens);
    }
    const times: number[] = [];
    for (let i = 0; i < WARM_RUNS; i += 1) {
      post({
        type: 'progress',
        step: `${size.toString()} words: run ${(i + 1).toString()}/${WARM_RUNS.toString()}`,
      });
      const start = performance.now();
      await classify(text);
      times.push(performance.now() - start);
    }
    timings[size] = summarise(times);
  }

  return {
    config: request.config,
    crossOriginIsolated: self.crossOriginIsolated,
    threadsUsed: wasm?.numThreads ?? 1,
    loadMs,
    timings,
    entities300,
  };
}

self.addEventListener('message', (event: MessageEvent<WorkerRunRequest>) => {
  run(event.data).then(
    (result) => {
      post({ type: 'result', result: { ...result, memoryBytes: null } });
    },
    (error: unknown) => {
      post({
        type: 'error',
        message: error instanceof Error ? error.message : 'unknown error',
      });
    },
  );
});
