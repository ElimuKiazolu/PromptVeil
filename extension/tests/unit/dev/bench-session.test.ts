import { describe, expect, it, vi } from 'vitest';
import {
  BREADCRUMB_KEY,
  clearBreadcrumb,
  describeBreadcrumb,
  readBreadcrumb,
  saveBreadcrumb,
  type StorageLike,
} from '@/src/dev/bench/breadcrumb.ts';
import {
  describeConfig,
  describeStage,
  errorMessage,
  isBenchMessage,
  isOffscreenReply,
  isWorkerRunRequest,
  type BenchMessage,
  type BenchStage,
  type WorkerResult,
} from '@/src/dev/bench/protocol.ts';
import {
  BenchFailure,
  buildRequest,
  measureMemory,
  offscreenUrl,
  portChannel,
  requestOffscreen,
  runBench,
  workerChannel,
  type BenchChannel,
  type ChannelEvents,
  type PortLike,
  type Timers,
  type WorkerLike,
} from '@/src/dev/bench/session.ts';
import { benchTexts } from '@/src/dev/bench/texts.ts';

const ROOT = 'chrome-extension://abcdefghijklmnop/';
const config = { device: 'wasm', threads: 1 } as const;
const request = buildRequest(config, ROOT, benchTexts());

const workerResult: WorkerResult = {
  config,
  crossOriginIsolated: false,
  threadsUsed: 1,
  tokenizerLoadMs: 100,
  modelLoadMs: 900,
  loadMs: 1000,
  timings: {
    50: { runs: 20, p50: 1, p95: 2, min: 1, max: 2 },
    150: { runs: 20, p50: 3, p95: 4, min: 3, max: 4 },
    300: { runs: 20, p50: 5, p95: 6, min: 5, max: 6 },
  },
  entities300: { PER: 3 },
};

/** Timers that only fire when the test advances them. */
class ManualTimers implements Timers {
  private now = 0;
  private nextId = 1;
  private readonly tasks = new Map<number, { at: number; run: () => void }>();

  setTimeout(callback: () => void, ms: number): number {
    const id = this.nextId;
    this.nextId += 1;
    this.tasks.set(id, { at: this.now + ms, run: callback });
    return id;
  }

  clearTimeout(id: number): void {
    this.tasks.delete(id);
  }

  advance(ms: number): void {
    this.now += ms;
    for (const [id, task] of [...this.tasks]) {
      if (task.at <= this.now) {
        this.tasks.delete(id);
        task.run();
      }
    }
  }

  get pending(): number {
    return this.tasks.size;
  }
}

class FakeWorker extends EventTarget implements WorkerLike {
  readonly posted: unknown[] = [];
  terminated = false;

  postMessage(message: unknown): void {
    this.posted.push(message);
  }

  terminate(): void {
    this.terminated = true;
  }

  emit(data: unknown): void {
    this.dispatchEvent(new MessageEvent('message', { data }));
  }
}

/** A worker 'error' event as browsers fire it (message may be empty). */
class WorkerErrorEvent extends Event {
  readonly message: string;

  constructor(message: string) {
    super('error', { cancelable: true });
    this.message = message;
  }
}

class FakePort implements PortLike {
  readonly posted: unknown[] = [];
  disconnected = false;
  private readonly messageListeners: ((message: unknown) => void)[] = [];
  private readonly disconnectListeners: (() => void)[] = [];

  onMessage = {
    addListener: (callback: (message: unknown) => void): void => {
      this.messageListeners.push(callback);
    },
  };

  onDisconnect = {
    addListener: (callback: () => void): void => {
      this.disconnectListeners.push(callback);
    },
  };

  postMessage(message: unknown): void {
    this.posted.push(message);
  }

  disconnect(): void {
    this.disconnected = true;
  }

  receive(message: unknown): void {
    for (const listener of this.messageListeners) listener(message);
  }

  /** The other end went away. */
  drop(): void {
    for (const listener of this.disconnectListeners) listener();
  }
}

class MemoryStorage implements StorageLike {
  readonly items = new Map<string, string>();

  getItem(key: string): string | null {
    return this.items.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.items.set(key, value);
  }

  removeItem(key: string): void {
    this.items.delete(key);
  }
}

describe('protocol', () => {
  it('describes stages, with input size and run number', () => {
    expect(describeStage('creating-offscreen')).toBe(
      'creating offscreen document',
    );
    expect(describeStage('loading-model')).toBe('loading model');
    expect(describeStage('warm-up', { size: 150 })).toBe('warm-up (150 words)');
    expect(describeStage('run', { size: 300, run: 3, of: 20 })).toBe(
      'run 3 of 20 (300 words)',
    );
  });

  it('describes configurations and paths', () => {
    expect(describeConfig({ device: 'wasm', threads: 1 })).toBe(
      'single thread',
    );
    expect(describeConfig({ device: 'wasm', threads: 4 }, 'offscreen')).toBe(
      'Offscreen · multi-thread (4)',
    );
    expect(describeConfig({ device: 'webgpu', threads: 1 }, 'direct')).toBe(
      'Direct worker · WebGPU',
    );
  });

  it('turns anything thrown into a readable message', () => {
    expect(errorMessage(new TypeError('bad url'))).toBe('TypeError: bad url');
    expect(errorMessage(new DOMException('', 'SecurityError'))).toBe(
      'SecurityError',
    );
    expect(errorMessage('plain text')).toBe('plain text');
    expect(errorMessage(42)).toBe('unknown error');
    expect(errorMessage(undefined)).toBe('unknown error');
  });

  it('accepts only well-formed messages', () => {
    expect(isBenchMessage({ type: 'stage', stage: 'loading-model' })).toBe(
      true,
    );
    expect(
      isBenchMessage({ type: 'error', stage: 'run', message: 'out of memory' }),
    ).toBe(true);
    expect(isBenchMessage({ type: 'result', result: workerResult })).toBe(true);
    expect(isBenchMessage({ type: 'stage', stage: 'unknown' })).toBe(false);
    expect(isBenchMessage({ type: 'error', stage: 'run' })).toBe(false);
    expect(isBenchMessage({ type: 'progress', step: 'x' })).toBe(false);
    expect(isBenchMessage(null)).toBe(false);
    expect(isBenchMessage('stage')).toBe(false);
  });

  it('checks offscreen replies and worker requests', () => {
    expect(isOffscreenReply({ type: 'offscreen-ready', created: true })).toBe(
      true,
    );
    expect(isOffscreenReply({ type: 'error', message: 'no' })).toBe(true);
    expect(isOffscreenReply({ type: 'offscreen-ready' })).toBe(false);
    expect(isWorkerRunRequest(request)).toBe(true);
    expect(isWorkerRunRequest({ ...request, modelBase: 1 })).toBe(false);
    expect(isWorkerRunRequest(config)).toBe(false);
  });
});

describe('extension URLs', () => {
  it('resolves model and WASM directories inside the extension', () => {
    expect(request.modelBase).toBe(`${ROOT}models/`);
    expect(request.wasmBase).toBe(`${ROOT}ort/`);
  });

  it('builds the offscreen URL from the extension root', () => {
    expect(offscreenUrl(ROOT)).toBe(`${ROOT}offscreen-bench.html`);
    // Even when given a page URL, it stays at the extension's root.
    expect(offscreenUrl(`${ROOT}bench.html`)).toBe(
      `${ROOT}offscreen-bench.html`,
    );
  });
});

describe('workerChannel', () => {
  const setup = (
    measure: () => Promise<{ bytes: number } | { unavailable: string }> = () =>
      Promise.resolve({ bytes: 5 }),
  ) => {
    const worker = new FakeWorker();
    const delivered: BenchMessage[] = [];
    const channel = workerChannel(worker, (m) => delivered.push(m), measure);
    return { worker, delivered, channel };
  };

  it('sends the request and forwards stages', () => {
    const { worker, delivered, channel } = setup();
    channel.send(request);
    worker.emit({ type: 'stage', stage: 'loading-tokenizer' });
    expect(worker.posted).toEqual([request]);
    expect(delivered).toEqual([{ type: 'stage', stage: 'loading-tokenizer' }]);
  });

  it('reports a worker error with the last stage the worker reached', () => {
    const { worker, delivered } = setup();
    worker.emit({ type: 'stage', stage: 'loading-model' });
    const event = new WorkerErrorEvent('RangeError: out of memory');
    worker.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(delivered.at(-1)).toEqual({
      type: 'error',
      stage: 'loading-model',
      message: 'worker error: RangeError: out of memory',
    });
  });

  it('reports a worker that fails to start', () => {
    const { worker, delivered } = setup();
    worker.dispatchEvent(new WorkerErrorEvent(''));
    expect(delivered).toEqual([
      {
        type: 'error',
        stage: 'starting-worker',
        message: expect.stringContaining('failed to load') as string,
      },
    ]);
  });

  it('reports unreadable and malformed messages once', () => {
    const { worker, delivered } = setup();
    worker.dispatchEvent(new Event('messageerror'));
    worker.emit({ nonsense: true });
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toMatchObject({
      type: 'error',
      stage: 'starting-worker',
    });
  });

  it('measures memory while the worker is alive, then delivers the result', async () => {
    const { worker, delivered } = setup();
    worker.emit({ type: 'result', result: workerResult });
    expect(delivered).toEqual([{ type: 'stage', stage: 'measuring-memory' }]);
    await vi.waitFor(() => {
      expect(delivered).toHaveLength(2);
    });
    expect(delivered[1]).toEqual({
      type: 'result',
      result: workerResult,
      memory: { bytes: 5 },
    });
  });

  it('still delivers the timings when memory measurement fails', async () => {
    const { worker, delivered } = setup(() =>
      Promise.reject(new DOMException('denied', 'SecurityError')),
    );
    worker.emit({ type: 'result', result: workerResult });
    await vi.waitFor(() => {
      expect(delivered).toHaveLength(2);
    });
    expect(delivered[1]).toEqual({
      type: 'result',
      result: workerResult,
      memory: { unavailable: 'SecurityError: denied' },
    });
  });

  it('terminates the worker on close and ignores it afterwards', () => {
    const { worker, delivered, channel } = setup();
    channel.close();
    worker.emit({ type: 'stage', stage: 'loading-model' });
    expect(worker.terminated).toBe(true);
    expect(delivered).toEqual([]);
  });
});

describe('portChannel', () => {
  const setup = (lastError?: string) => {
    const port = new FakePort();
    const messages: BenchMessage[] = [];
    const closed: string[] = [];
    const channel = portChannel(
      port,
      {
        message: (m) => messages.push(m),
        closed: (reason) => closed.push(reason),
      },
      () => lastError,
    );
    return { port, messages, closed, channel };
  };

  it('relays messages from the offscreen document', () => {
    const { port, messages, channel } = setup();
    channel.send(request);
    port.receive({ type: 'stage', stage: 'warm-up', detail: { size: 50 } });
    expect(port.posted).toEqual([request]);
    expect(messages).toEqual([
      { type: 'stage', stage: 'warm-up', detail: { size: 50 } },
    ]);
  });

  it('reports a closed connection with the browser’s reason', () => {
    const { port, closed } = setup(
      'Could not establish connection. Receiving end does not exist.',
    );
    port.drop();
    expect(closed).toEqual([
      'the connection to the offscreen document closed: Could not establish connection. Receiving end does not exist.',
    ]);
  });

  it('reports an unexpected message', () => {
    const { port, closed } = setup();
    port.receive({ hello: 'world' });
    expect(closed).toEqual([
      'the offscreen document sent an unexpected message',
    ]);
  });

  it('disconnects once on close and then stays quiet', () => {
    const { port, closed, channel } = setup();
    channel.close();
    channel.close();
    port.drop();
    expect(port.disconnected).toBe(true);
    expect(closed).toEqual([]);
  });
});

describe('runBench', () => {
  /** A channel the test drives through the events runBench gives it. */
  const scripted = () => {
    let events: ChannelEvents | null = null;
    const sent: unknown[] = [];
    let closes = 0;
    const open = (e: ChannelEvents): BenchChannel => {
      events = e;
      return {
        send: (r) => sent.push(r),
        close: () => {
          closes += 1;
        },
      };
    };
    const emit = (message: BenchMessage): void => {
      events?.message(message);
    };
    const close = (reason: string): void => {
      events?.closed(reason);
    };
    return { open, emit, close, sent, closes: () => closes };
  };

  const start = (open: (e: ChannelEvents) => BenchChannel) => {
    const timers = new ManualTimers();
    const stages: string[] = [];
    const promise = runBench({
      open,
      request,
      onStage: (stage, detail) => stages.push(describeStage(stage, detail)),
      stallMs: 10_000,
      timers,
    });
    return { promise, timers, stages };
  };

  const failureOf = async (
    promise: Promise<unknown>,
  ): Promise<BenchFailure> => {
    const error: unknown = await promise.then(
      () => null,
      (e: unknown) => e,
    );
    if (!(error instanceof BenchFailure)) throw new Error('expected a failure');
    return error;
  };

  it('reports every stage and resolves with the result and memory', async () => {
    const channel = scripted();
    const { promise, stages, timers } = start(channel.open);
    channel.emit({ type: 'stage', stage: 'loading-tokenizer' });
    channel.emit({ type: 'stage', stage: 'loading-model' });
    channel.emit({ type: 'stage', stage: 'warm-up', detail: { size: 50 } });
    channel.emit({
      type: 'stage',
      stage: 'run',
      detail: { size: 50, run: 1, of: 20 },
    });
    channel.emit({
      type: 'result',
      result: workerResult,
      memory: { bytes: 9 },
    });
    await expect(promise).resolves.toEqual({
      result: workerResult,
      memory: { bytes: 9 },
    });
    expect(stages).toEqual([
      'starting worker',
      'loading tokenizer',
      'loading model',
      'warm-up (50 words)',
      'run 1 of 20 (50 words)',
    ]);
    expect(channel.sent).toEqual([request]);
    expect(channel.closes()).toBe(1);
    expect(timers.pending).toBe(0);
  });

  it('fails with the stage the worker reported', async () => {
    const channel = scripted();
    const { promise } = start(channel.open);
    channel.emit({ type: 'stage', stage: 'loading-model' });
    channel.emit({
      type: 'error',
      stage: 'loading-model',
      message: 'no available backend found',
    });
    const failure = await failureOf(promise);
    expect(failure.stage).toBe('loading-model');
    expect(failure.message).toBe('no available backend found');
    expect(channel.closes()).toBe(1);
  });

  it('fails at the current stage when the channel closes', async () => {
    const channel = scripted();
    const { promise } = start(channel.open);
    channel.emit({ type: 'stage', stage: 'warm-up', detail: { size: 300 } });
    channel.close('the connection to the offscreen document closed');
    const failure = await failureOf(promise);
    expect(failure.stage).toBe('warm-up');
    expect(failure.message).toContain('closed');
  });

  it('fails a stage that stops making progress, and only that long after its last message', async () => {
    const channel = scripted();
    const { promise, timers } = start(channel.open);
    timers.advance(9_000);
    channel.emit({ type: 'stage', stage: 'loading-model' });
    timers.advance(9_000);
    channel.emit({ type: 'stage', stage: 'warm-up', detail: { size: 50 } });
    timers.advance(10_000);
    const failure = await failureOf(promise);
    expect(failure.stage).toBe('warm-up');
    expect(failure.message).toBe('no progress for 10 s');
    expect(channel.closes()).toBe(1);
  });

  it('fails at starting-worker when the worker cannot be created', async () => {
    const { promise, timers } = start(() => {
      throw new DOMException('Script at x cannot be accessed', 'SecurityError');
    });
    const failure = await failureOf(promise);
    expect(failure.stage).toBe('starting-worker');
    expect(failure.message).toBe(
      'SecurityError: Script at x cannot be accessed',
    );
    expect(timers.pending).toBe(0);
  });

  it('fails when the request cannot be sent', async () => {
    const { promise } = start(() => ({
      send: () => {
        throw new Error('Attempting to use a disconnected port object');
      },
      close: () => undefined,
    }));
    const failure = await failureOf(promise);
    expect(failure.stage).toBe('starting-worker');
    expect(failure.message).toContain('disconnected port');
  });

  it('closes a channel that failed while opening and sends nothing', async () => {
    let closed = 0;
    const sent: unknown[] = [];
    const { promise } = start((events) => {
      events.closed('Receiving end does not exist.');
      return {
        send: (r) => sent.push(r),
        close: () => {
          closed += 1;
        },
      };
    });
    const failure = await failureOf(promise);
    expect(failure.stage).toBe('starting-worker');
    expect(closed).toBe(1);
    expect(sent).toEqual([]);
  });

  it('ignores messages after it has settled', async () => {
    const channel = scripted();
    const stagesSeen: BenchStage[] = [];
    const promise = runBench({
      open: channel.open,
      request,
      onStage: (stage) => stagesSeen.push(stage),
      stallMs: 10_000,
      timers: new ManualTimers(),
    });
    channel.emit({ type: 'error', stage: 'run', message: 'aborted' });
    channel.emit({ type: 'stage', stage: 'loading-model' });
    channel.emit({ type: 'result', result: workerResult });
    await failureOf(promise);
    expect(stagesSeen).toEqual(['starting-worker']);
  });

  it('marks memory as not measured when the host did not measure it', async () => {
    const channel = scripted();
    const { promise } = start(channel.open);
    channel.emit({ type: 'result', result: workerResult });
    await expect(promise).resolves.toEqual({
      result: workerResult,
      memory: { unavailable: 'not measured' },
    });
  });
});

describe('requestOffscreen', () => {
  const setup = (lastError?: string) => {
    const port = new FakePort();
    const timers = new ManualTimers();
    const promise = requestOffscreen(port, () => lastError, 30_000, timers);
    return { port, timers, promise };
  };

  it('resolves when the background reports the document is ready', async () => {
    const { port, timers, promise } = setup();
    port.receive({ type: 'offscreen-ready', created: true });
    await expect(promise).resolves.toBe(true);
    expect(port.disconnected).toBe(true);
    expect(timers.pending).toBe(0);
  });

  it('fails at creating-offscreen with the background’s error', async () => {
    const { port, promise } = setup();
    port.receive({
      type: 'error',
      message: 'Error: Only a single offscreen document may be created.',
    });
    await expect(promise).rejects.toMatchObject({
      stage: 'creating-offscreen',
      message: 'Error: Only a single offscreen document may be created.',
    });
  });

  it('fails when the background goes away', async () => {
    const { port, promise } = setup('The message port closed.');
    port.drop();
    await expect(promise).rejects.toMatchObject({
      stage: 'creating-offscreen',
      message: 'the background closed the connection: The message port closed.',
    });
  });

  it('fails when the background does not answer', async () => {
    const { timers, promise } = setup();
    timers.advance(30_000);
    await expect(promise).rejects.toMatchObject({
      stage: 'creating-offscreen',
      message: 'the background did not answer within 30 s',
    });
  });

  it('fails on an unexpected reply', async () => {
    const { port, promise } = setup();
    port.receive({ type: 'offscreen-ready' });
    await expect(promise).rejects.toBeInstanceOf(BenchFailure);
  });
});

describe('measureMemory', () => {
  it('says why memory is unavailable outside cross-origin isolation', async () => {
    vi.stubGlobal('self', { crossOriginIsolated: false });
    vi.stubGlobal('performance', {
      measureUserAgentSpecificMemory: () => Promise.resolve({ bytes: 1 }),
    });
    try {
      await expect(measureMemory()).resolves.toEqual({
        unavailable: 'needs a cross-origin isolated build',
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('measures when isolated', async () => {
    vi.stubGlobal('self', { crossOriginIsolated: true });
    vi.stubGlobal('performance', {
      measureUserAgentSpecificMemory: () => Promise.resolve({ bytes: 1234 }),
    });
    try {
      await expect(measureMemory()).resolves.toEqual({ bytes: 1234 });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('reports a browser without the API', async () => {
    vi.stubGlobal('performance', {});
    try {
      await expect(measureMemory()).resolves.toEqual({
        unavailable: 'not supported by this browser',
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('breadcrumb', () => {
  const crumb = {
    path: 'offscreen' as const,
    config,
    stage: 'creating-offscreen' as const,
    at: Date.UTC(2026, 9, 19, 12, 0, 0),
  };

  it('round-trips and clears', () => {
    const storage = new MemoryStorage();
    expect(readBreadcrumb(storage)).toBeNull();
    saveBreadcrumb(storage, crumb);
    expect(readBreadcrumb(storage)).toEqual(crumb);
    clearBreadcrumb(storage);
    expect(readBreadcrumb(storage)).toBeNull();
  });

  it('drops corrupted or foreign entries', () => {
    const storage = new MemoryStorage();
    storage.setItem(BREADCRUMB_KEY, '{not json');
    expect(readBreadcrumb(storage)).toBeNull();
    expect(storage.items.has(BREADCRUMB_KEY)).toBe(false);
    storage.setItem(BREADCRUMB_KEY, JSON.stringify({ path: 'elsewhere' }));
    expect(readBreadcrumb(storage)).toBeNull();
    expect(storage.items.has(BREADCRUMB_KEY)).toBe(false);
  });

  it('describes the killed run and its stage', () => {
    const text = describeBreadcrumb({
      ...crumb,
      stage: 'run',
      detail: { size: 150, run: 7, of: 20 },
    });
    expect(text).toContain('Offscreen · single thread');
    expect(text).toContain('run 7 of 20 (150 words)');
    expect(text).toContain('killed');
  });
});
