import type { BenchSize } from './texts.ts';
import type { TimingSummary } from './stats.ts';

/** Port from the benchmark page to the offscreen document (one run per port). */
export const BENCH_PORT = 'promptveil-bench';
/** Port from the benchmark page to the background (offscreen creation). */
export const BENCH_OFFSCREEN_PORT = 'promptveil-bench-offscreen';
/** The offscreen document's page, relative to the extension root. */
export const OFFSCREEN_PATH = '/offscreen-bench.html';
export const MODEL_ID = 'onnx-community/distilbert-NER-ONNX';
/** Warm runs per input, after one warm-up run. */
export const WARM_RUNS = 20;

export type BenchDevice = 'wasm' | 'webgpu';

export interface BenchConfig {
  device: BenchDevice;
  /** WASM threads; 1 is the single-thread baseline. */
  threads: number;
}

/** Where the worker runs: inside the offscreen document, or started by the page. */
export type BenchPath = 'offscreen' | 'direct';

/** Every step of a run, in order. A failure is reported with the step it happened in. */
export type BenchStage =
  | 'creating-offscreen'
  | 'starting-worker'
  | 'loading-tokenizer'
  | 'loading-model'
  | 'warm-up'
  | 'run'
  | 'measuring-memory';

/** Which input and which timed run, for the warm-up and run stages. */
export interface StageDetail {
  size: BenchSize;
  /** 1-based run number; absent during warm-up. */
  run?: number;
  of?: number;
}

/** Sent to the worker: everything it needs, since workers have no extension APIs. */
export interface WorkerRunRequest {
  type: 'run';
  config: BenchConfig;
  modelBase: string;
  wasmBase: string;
  texts: Record<BenchSize, string>;
}

export interface BenchResult {
  config: BenchConfig;
  path: BenchPath;
  crossOriginIsolated: boolean;
  /** Threads ONNX Runtime was configured with. */
  threadsUsed: number;
  tokenizerLoadMs: number;
  modelLoadMs: number;
  /** Tokenizer plus model: the cold load the targets refer to. */
  loadMs: number;
  timings: Record<BenchSize, TimingSummary>;
  /** Entity type → count for the 300-word input; never values. */
  entities300: Record<string, number>;
  /** Hosting document + workers, measured while the model is loaded. */
  memory: MemoryReading;
}

/** Memory of the hosting document and its workers, or why it is unavailable. */
export type MemoryReading = { bytes: number } | { unavailable: string };

/** The worker's result before its host adds the path and memory. */
export type WorkerResult = Omit<BenchResult, 'path' | 'memory'>;

export type BenchMessage =
  | { type: 'stage'; stage: BenchStage; detail?: StageDetail }
  | { type: 'result'; result: WorkerResult; memory?: MemoryReading }
  | { type: 'error'; stage: BenchStage; message: string };

/** From the background, in answer to a page on BENCH_OFFSCREEN_PORT. */
export type OffscreenReply =
  | { type: 'offscreen-ready'; created: boolean }
  | { type: 'error'; message: string };

const STAGE_LABELS: Record<BenchStage, string> = {
  'creating-offscreen': 'creating offscreen document',
  'starting-worker': 'starting worker',
  'loading-tokenizer': 'loading tokenizer',
  'loading-model': 'loading model',
  'warm-up': 'warm-up',
  run: 'run',
  'measuring-memory': 'measuring memory',
};

export function describeStage(stage: BenchStage, detail?: StageDetail): string {
  const label = STAGE_LABELS[stage];
  if (!detail) return label;
  const words = `${detail.size.toString()} words`;
  if (stage === 'run' && detail.run !== undefined && detail.of !== undefined) {
    return `run ${detail.run.toString()} of ${detail.of.toString()} (${words})`;
  }
  return `${label} (${words})`;
}

export function describeConfig(config: BenchConfig, path?: BenchPath): string {
  const backend =
    config.device === 'webgpu'
      ? 'WebGPU'
      : config.threads === 1
        ? 'single thread'
        : `multi-thread (${config.threads.toString()})`;
  if (!path) return backend;
  return `${path === 'offscreen' ? 'Offscreen' : 'Direct worker'} · ${backend}`;
}

/** A readable message for anything thrown, including DOMExceptions and non-errors. */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message === ''
      ? error.name
      : `${error.name}: ${error.message}`;
  }
  if (typeof error === 'string' && error !== '') return error;
  return 'unknown error';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

// A function rather than a module-level Set: the background imports this
// module, and a top-level constructor call would survive tree-shaking in
// builds where the benchmark is dropped.
function isStage(value: unknown): value is BenchStage {
  return typeof value === 'string' && Object.hasOwn(STAGE_LABELS, value);
}

/** Messages cross worker and port boundaries, so their shape is checked on arrival. */
export function isBenchMessage(value: unknown): value is BenchMessage {
  if (!isRecord(value)) return false;
  switch (value.type) {
    case 'stage':
      return isStage(value.stage);
    case 'result':
      return isRecord(value.result);
    case 'error':
      return isStage(value.stage) && typeof value.message === 'string';
    default:
      return false;
  }
}

export function isOffscreenReply(value: unknown): value is OffscreenReply {
  if (!isRecord(value)) return false;
  if (value.type === 'offscreen-ready')
    return typeof value.created === 'boolean';
  return value.type === 'error' && typeof value.message === 'string';
}

export function isWorkerRunRequest(value: unknown): value is WorkerRunRequest {
  return (
    isRecord(value) &&
    value.type === 'run' &&
    isRecord(value.config) &&
    typeof value.modelBase === 'string' &&
    typeof value.wasmBase === 'string' &&
    isRecord(value.texts)
  );
}
