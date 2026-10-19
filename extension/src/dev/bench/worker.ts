/**
 * Dev-only benchmark worker: loads the NER model with Transformers.js from
 * the extension's own files and times it. Remote model loading is disabled.
 * Reports a stage before every step, so a failure or hang can be placed.
 */
import {
  AutoModelForTokenClassification,
  AutoTokenizer,
  TokenClassificationPipeline,
  env,
} from '@huggingface/transformers';
import { countEntities, type TokenEntity } from './entities.ts';
import {
  MODEL_ID,
  WARM_RUNS,
  errorMessage,
  isWorkerRunRequest,
  type BenchMessage,
  type BenchStage,
  type StageDetail,
  type WorkerResult,
  type WorkerRunRequest,
} from './protocol.ts';
import { summarise } from './stats.ts';
import { BENCH_WORD_TARGETS } from './texts.ts';

const post = (message: BenchMessage): void => {
  self.postMessage(message);
};

let stage: BenchStage = 'starting-worker';
let started = false;
let failed = false;

const enter = (next: BenchStage, detail?: StageDetail): void => {
  stage = next;
  post(detail ? { type: 'stage', stage, detail } : { type: 'stage', stage });
};

const fail = (message: string): void => {
  if (failed) return;
  failed = true;
  post({ type: 'error', stage, message });
};

function isTokenEntity(value: unknown): value is TokenEntity {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { entity?: unknown }).entity === 'string' &&
    typeof (value as { index?: unknown }).index === 'number'
  );
}

async function run(request: WorkerRunRequest): Promise<WorkerResult> {
  env.allowRemoteModels = false;
  env.allowLocalModels = true;
  env.localModelPath = request.modelBase;
  env.useBrowserCache = false;
  const wasm = env.backends.onnx.wasm;
  if (wasm) {
    wasm.wasmPaths = request.wasmBase;
    wasm.numThreads = request.config.threads;
  }

  enter('loading-tokenizer');
  const tokenizerStart = performance.now();
  const tokenizer = await AutoTokenizer.from_pretrained(MODEL_ID);
  const tokenizerLoadMs = performance.now() - tokenizerStart;

  enter('loading-model');
  const modelStart = performance.now();
  const model = await AutoModelForTokenClassification.from_pretrained(
    MODEL_ID,
    { dtype: 'q8', device: request.config.device },
  );
  const modelLoadMs = performance.now() - modelStart;
  const classify = new TokenClassificationPipeline({
    task: 'token-classification',
    model,
    tokenizer,
  });

  const timings = {} as WorkerResult['timings'];
  let entities300: Record<string, number> = {};
  for (const size of BENCH_WORD_TARGETS) {
    const text = request.texts[size];
    enter('warm-up', { size });
    const output: unknown = await classify(text);
    if (size === 300) {
      const tokens = Array.isArray(output) ? output.filter(isTokenEntity) : [];
      entities300 = countEntities(tokens);
    }
    const times: number[] = [];
    for (let i = 0; i < WARM_RUNS; i += 1) {
      enter('run', { size, run: i + 1, of: WARM_RUNS });
      const start = performance.now();
      await classify(text);
      times.push(performance.now() - start);
    }
    timings[size] = summarise(times);
  }
  await classify.dispose();

  return {
    config: request.config,
    crossOriginIsolated: self.crossOriginIsolated,
    threadsUsed: wasm?.numThreads ?? 1,
    tokenizerLoadMs,
    modelLoadMs,
    loadMs: tokenizerLoadMs + modelLoadMs,
    timings,
    entities300,
  };
}

// Errors that escape the run (e.g. thrown inside ONNX Runtime callbacks) are
// reported with the stage instead of surfacing only as a console error.
self.addEventListener('error', (event) => {
  event.preventDefault();
  fail(`uncaught error: ${event.message}`);
});
self.addEventListener('unhandledrejection', (event) => {
  event.preventDefault();
  fail(`unhandled rejection: ${errorMessage(event.reason)}`);
});

self.addEventListener('message', (event: MessageEvent) => {
  const data: unknown = event.data;
  if (started) {
    fail('the worker received a second run request');
    return;
  }
  started = true;
  if (!isWorkerRunRequest(data)) {
    fail('the worker received a malformed run request');
    return;
  }
  run(data).then(
    (result) => {
      if (!failed) post({ type: 'result', result });
    },
    (error: unknown) => {
      fail(errorMessage(error));
    },
  );
});
