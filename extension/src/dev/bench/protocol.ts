import type { BenchSize } from './texts.ts';
import type { TimingSummary } from './stats.ts';

export const BENCH_PORT = 'promptveil-bench';
export const MODEL_ID = 'onnx-community/distilbert-NER-ONNX';
/** Warm runs per input, after one warm-up run. */
export const WARM_RUNS = 20;

export type BenchDevice = 'wasm' | 'webgpu';

export interface BenchConfig {
  device: BenchDevice;
  /** WASM threads; 1 is the single-thread baseline. */
  threads: number;
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
  crossOriginIsolated: boolean;
  /** Threads ONNX Runtime was configured with. */
  threadsUsed: number;
  loadMs: number;
  timings: Record<BenchSize, TimingSummary>;
  /** Entity type → count for the 300-word input; never values. */
  entities300: Record<string, number>;
  /** Page + workers memory, when measureUserAgentSpecificMemory is available. */
  memoryBytes: number | null;
}

export type BenchMessage =
  | { type: 'progress'; step: string }
  | { type: 'result'; result: BenchResult }
  | { type: 'error'; message: string };
