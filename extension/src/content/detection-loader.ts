import type {
  DetectionRuntime,
  createDetection,
} from '@/src/core/detect/bundle.ts';
import { devlog } from '@/src/shared/devlog.ts';

/**
 * The detection module's interface as the content script uses it. Only types
 * are imported here: the module itself is loaded at run time, so none of its
 * code is part of the document_start script.
 */
export interface DetectionModuleApi {
  DETECTION_API_VERSION: 1;
  createDetection: typeof createDetection;
}

export type DetectionLoadFailure =
  'load-failed' | 'load-timeout' | 'invalid-module' | 'disposed';

export class DetectionLoadError extends Error {
  readonly reason: DetectionLoadFailure;

  constructor(reason: DetectionLoadFailure, options?: ErrorOptions) {
    super(reason, options);
    this.name = 'DetectionLoadError';
    this.reason = reason;
  }
}

export interface LazyDetectionOptions {
  /** Imports the module, e.g. `import(url)` of the web-accessible file. */
  load: () => Promise<unknown>;
  /** Creates the runtime from the loaded module. */
  create: (module: DetectionModuleApi) => DetectionRuntime;
  /** Longest wait for the module; a Send waiting longer is blocked. */
  timeoutMs?: number;
}

export interface LazyDetection {
  /** Starts loading if it has not started (or after a failed attempt). */
  start(): void;
  /** The runtime once loaded; rejects with a DetectionLoadError otherwise. */
  ready(): Promise<DetectionRuntime>;
  /** The runtime if it has loaded, else null. */
  current(): DetectionRuntime | null;
  /** Disposes the runtime and refuses all later work. */
  dispose(): void;
}

export const DEFAULT_LOAD_TIMEOUT_MS = 10_000;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  (typeof value === 'object' || typeof value === 'function') && value !== null;

function isDetectionModule(value: unknown): value is DetectionModuleApi {
  return (
    isRecord(value) &&
    value.DETECTION_API_VERSION === 1 &&
    typeof value.createDetection === 'function'
  );
}

/**
 * Loads the detection module once, on first need. Sends before it is ready
 * wait for it; if it fails to load or takes longer than the timeout, the
 * promise rejects and the Send is blocked (fail closed). A later Send tries
 * again.
 */
export function createLazyDetection({
  load,
  create,
  timeoutMs = DEFAULT_LOAD_TIMEOUT_MS,
}: LazyDetectionOptions): LazyDetection {
  let runtime: DetectionRuntime | null = null;
  let loading: Promise<DetectionRuntime> | null = null;
  let disposed = false;

  const attempt = (): Promise<DetectionRuntime> =>
    new Promise<DetectionRuntime>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new DetectionLoadError('load-timeout'));
      }, timeoutMs);
      load().then(
        (module) => {
          clearTimeout(timer);
          if (disposed) {
            reject(new DetectionLoadError('disposed'));
          } else if (!isDetectionModule(module)) {
            reject(new DetectionLoadError('invalid-module'));
          } else {
            runtime = create(module);
            devlog('detection.loaded');
            resolve(runtime);
          }
        },
        (error: unknown) => {
          clearTimeout(timer);
          reject(new DetectionLoadError('load-failed', { cause: error }));
        },
      );
    });

  const ready = (): Promise<DetectionRuntime> => {
    if (disposed) return Promise.reject(new DetectionLoadError('disposed'));
    if (runtime !== null) return Promise.resolve(runtime);
    loading ??= attempt().catch((error: unknown) => {
      // Let the next caller try again.
      loading = null;
      throw error;
    });
    return loading;
  };

  return {
    start() {
      ready().catch((error: unknown) => {
        // A Send retries the load and is blocked if it fails again.
        devlog('detection.failed', {
          reason:
            error instanceof DetectionLoadError ? error.reason : 'load-failed',
        });
      });
    },
    ready,
    current: () => runtime,
    dispose() {
      disposed = true;
      runtime?.dispose();
      runtime = null;
    },
  };
}
