/**
 * Runs one benchmark configuration and turns every way it can go wrong
 * (worker failing to start or throwing, a closed connection, a malformed
 * message, a step that stops making progress) into a BenchFailure that names
 * the stage it happened in. Shared by the page, the offscreen document and
 * the direct-worker path; browser objects are passed in, so it is testable.
 */
import {
  OFFSCREEN_PATH,
  errorMessage,
  isBenchMessage,
  isOffscreenReply,
  type BenchConfig,
  type BenchMessage,
  type BenchStage,
  type MemoryReading,
  type StageDetail,
  type WorkerResult,
  type WorkerRunRequest,
} from './protocol.ts';
import type { BenchSize } from './texts.ts';

export class BenchFailure extends Error {
  override readonly name = 'BenchFailure';
  readonly stage: BenchStage;

  constructor(stage: BenchStage, message: string) {
    super(message);
    this.stage = stage;
  }
}

export interface Timers {
  setTimeout(callback: () => void, ms: number): number;
  clearTimeout(id: number): void;
}

export const browserTimers: Timers = {
  setTimeout: (callback, ms) => self.setTimeout(callback, ms),
  clearTimeout: (id) => {
    self.clearTimeout(id);
  },
};

export interface HostedResult {
  result: WorkerResult;
  memory: MemoryReading;
}

/** What a channel reports to the run. */
export interface ChannelEvents {
  message(message: BenchMessage): void;
  /** The channel ended without a result or error message. */
  closed(reason: string): void;
}

/** A connection to one benchmark worker, direct or through the offscreen document. */
export interface BenchChannel {
  send(request: WorkerRunRequest): void;
  close(): void;
}

/** The parts of a Worker the channel uses. */
export interface WorkerLike extends EventTarget {
  postMessage(message: unknown): void;
  terminate(): void;
}

function eventText(event: Event): string {
  const message: unknown = Reflect.get(event, 'message');
  return typeof message === 'string' ? message : '';
}

/**
 * Wraps a worker the caller has just created. Worker failures become error
 * messages tagged with the last stage the worker reported, so the host only
 * ever deals in BenchMessages. On a result, memory is measured while the
 * worker (and its model) is still alive.
 */
export function workerChannel(
  worker: WorkerLike,
  deliver: (message: BenchMessage) => void,
  measureMemory: () => Promise<MemoryReading>,
): BenchChannel {
  let stage: BenchStage = 'starting-worker';
  let done = false;
  const fail = (message: string): void => {
    if (done) return;
    done = true;
    deliver({ type: 'error', stage, message });
  };

  worker.addEventListener('message', (event) => {
    if (done) return;
    const data: unknown = (event as MessageEvent).data;
    if (!isBenchMessage(data)) {
      fail('the worker sent a message in an unexpected format');
      return;
    }
    if (data.type === 'stage') {
      stage = data.stage;
      deliver(data);
      return;
    }
    if (data.type === 'error') {
      done = true;
      deliver(data);
      return;
    }
    stage = 'measuring-memory';
    deliver({ type: 'stage', stage });
    measureMemory().then(
      (memory) => {
        if (done) return;
        done = true;
        deliver({ type: 'result', result: data.result, memory });
      },
      (error: unknown) => {
        if (done) return;
        done = true;
        deliver({
          type: 'result',
          result: data.result,
          memory: { unavailable: errorMessage(error) },
        });
      },
    );
  });
  worker.addEventListener('error', (event) => {
    // Keeps the error out of the console as "uncaught"; it is reported here.
    event.preventDefault();
    const text = eventText(event);
    fail(
      text === ''
        ? 'the worker failed to load or threw while starting (no details from the browser)'
        : `worker error: ${text}`,
    );
  });
  worker.addEventListener('messageerror', () => {
    fail('a message from the worker could not be read');
  });

  return {
    send(request) {
      worker.postMessage(request);
    },
    close() {
      done = true;
      worker.terminate();
    },
  };
}

/** The parts of a runtime Port the benchmark uses. */
export interface PortLike {
  postMessage(message: unknown): void;
  disconnect(): void;
  onMessage: { addListener(callback: (message: unknown) => void): void };
  onDisconnect: { addListener(callback: () => void): void };
}

/** Page side of the offscreen path: the offscreen document relays BenchMessages over a port. */
export function portChannel(
  port: PortLike,
  events: ChannelEvents,
  lastError: () => string | undefined,
): BenchChannel {
  let open = true;
  port.onMessage.addListener((message) => {
    if (!open) return;
    if (isBenchMessage(message)) events.message(message);
    else events.closed('the offscreen document sent an unexpected message');
  });
  port.onDisconnect.addListener(() => {
    if (!open) return;
    open = false;
    const detail = lastError();
    events.closed(
      `the connection to the offscreen document closed${detail ? `: ${detail}` : ' (no offscreen document is listening, or it was closed)'}`,
    );
  });
  return {
    send(request) {
      port.postMessage(request);
    },
    close() {
      if (!open) return;
      open = false;
      port.disconnect();
    },
  };
}

export interface RunOptions {
  open: (events: ChannelEvents) => BenchChannel;
  request: WorkerRunRequest;
  onStage: (stage: BenchStage, detail?: StageDetail) => void;
  /** Fail when no message arrives for this long. */
  stallMs: number;
  timers?: Timers;
}

/** One run over one channel; rejects only with a BenchFailure. */
export function runBench({
  open,
  request,
  onStage,
  stallMs,
  timers = browserTimers,
}: RunOptions): Promise<HostedResult> {
  return new Promise((resolve, reject) => {
    let stage: BenchStage = 'starting-worker';
    let settled = false;
    let channel: BenchChannel | null = null;
    let stall: number | undefined;
    // Read through a function: the channel can settle the run from inside
    // open(), which control-flow analysis cannot see.
    const isSettled = (): boolean => settled;

    const finish = (settle: () => void): void => {
      if (settled) return;
      settled = true;
      if (stall !== undefined) timers.clearTimeout(stall);
      channel?.close();
      settle();
    };
    const fail = (failedStage: BenchStage, message: string): void => {
      finish(() => {
        reject(new BenchFailure(failedStage, message));
      });
    };
    const enter = (next: BenchStage, detail?: StageDetail): void => {
      stage = next;
      if (stall !== undefined) timers.clearTimeout(stall);
      stall = timers.setTimeout(() => {
        fail(
          stage,
          `no progress for ${Math.round(stallMs / 1000).toString()} s`,
        );
      }, stallMs);
      onStage(next, detail);
    };

    try {
      enter('starting-worker');
      channel = open({
        message(message) {
          if (settled) return;
          if (message.type === 'stage') {
            enter(message.stage, message.detail);
          } else if (message.type === 'error') {
            fail(message.stage, message.message);
          } else {
            const { result, memory } = message;
            finish(() => {
              resolve({
                result,
                memory: memory ?? { unavailable: 'not measured' },
              });
            });
          }
        },
        closed(reason) {
          fail(stage, reason);
        },
      });
      if (isSettled()) channel.close();
      else channel.send(request);
    } catch (error) {
      fail(stage, errorMessage(error));
    }
  });
}

/**
 * Asks the background to create the offscreen document (TR-N1: the service
 * worker owns it). Resolves with whether a new document was created.
 */
export function requestOffscreen(
  port: PortLike,
  lastError: () => string | undefined,
  timeoutMs: number,
  timers: Timers = browserTimers,
): Promise<boolean> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (settle: () => void): void => {
      if (settled) return;
      settled = true;
      timers.clearTimeout(timeout);
      port.disconnect();
      settle();
    };
    const fail = (message: string): void => {
      finish(() => {
        reject(new BenchFailure('creating-offscreen', message));
      });
    };
    const timeout = timers.setTimeout(() => {
      fail(
        `the background did not answer within ${Math.round(timeoutMs / 1000).toString()} s`,
      );
    }, timeoutMs);
    port.onMessage.addListener((message) => {
      if (!isOffscreenReply(message)) {
        fail('the background sent an unexpected message');
      } else if (message.type === 'error') {
        fail(message.message);
      } else {
        finish(() => {
          resolve(message.created);
        });
      }
    });
    port.onDisconnect.addListener(() => {
      const detail = lastError();
      fail(
        `the background closed the connection${detail ? `: ${detail}` : ''}`,
      );
    });
  });
}

/** The worker's request; model and WASM files are resolved inside the extension. */
export function buildRequest(
  config: BenchConfig,
  extensionRoot: string,
  texts: Record<BenchSize, string>,
): WorkerRunRequest {
  return {
    type: 'run',
    config,
    modelBase: new URL('models/', extensionRoot).href,
    wasmBase: new URL('ort/', extensionRoot).href,
    texts,
  };
}

/** The offscreen page's URL: always inside the extension, never a dev server. */
export function offscreenUrl(extensionRoot: string): string {
  const url = new URL(OFFSCREEN_PATH, extensionRoot);
  if (url.origin !== new URL(extensionRoot).origin) {
    throw new Error('offscreen document URL is outside the extension');
  }
  return url.href;
}

interface MemoryMeasurement {
  bytes: number;
}

/** Page + workers memory where the browser offers it (cross-origin isolated only). */
export async function measureMemory(): Promise<MemoryReading> {
  const measure: unknown = Reflect.get(
    performance,
    'measureUserAgentSpecificMemory',
  );
  if (typeof measure !== 'function') {
    return { unavailable: 'not supported by this browser' };
  }
  if (!self.crossOriginIsolated) {
    return { unavailable: 'needs a cross-origin isolated build' };
  }
  const result = (await Reflect.apply(
    measure,
    performance,
    [],
  )) as MemoryMeasurement;
  return { bytes: result.bytes };
}
