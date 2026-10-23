import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DetectionLoadError,
  createLazyDetection,
  type DetectionModuleApi,
} from '@/src/content/detection-loader.ts';
import { startInstance } from '@/src/content/instance.ts';
import type { NetBridge } from '@/src/content/net-bridge.ts';
import type { DetectionRuntime } from '@/src/core/detect/bundle.ts';
import { createSpikeMasker } from '@/src/core/spike-mask.ts';
import { detectEmailsOnly } from '../spike-detect.ts';
import { flush, pressKey, setUp } from './harness.ts';

function fakeRuntime(): DetectionRuntime {
  return {
    analyse: (text) => detectEmailsOnly(text),
    prepare: () => Promise.resolve(),
    clear: vi.fn(),
    dispose: vi.fn(),
    warmUp: () => Promise.resolve(),
  };
}

function fakeModule(runtime: DetectionRuntime): DetectionModuleApi {
  return {
    DETECTION_API_VERSION: 1,
    createDetection: () => runtime,
  };
}

/** A load the test resolves or rejects by hand. */
function controllableLoad() {
  let settle: {
    resolve: (m: unknown) => void;
    reject: (e: unknown) => void;
  } | null = null;
  const load = vi.fn(
    () =>
      new Promise<unknown>((resolve, reject) => {
        settle = { resolve, reject };
      }),
  );
  return {
    load,
    resolve: (module: unknown) => {
      settle?.resolve(module);
    },
    reject: (error: unknown) => {
      settle?.reject(error);
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('createLazyDetection', () => {
  it('loads once and shares the runtime', async () => {
    const runtime = fakeRuntime();
    const load = vi.fn(() => Promise.resolve<unknown>(fakeModule(runtime)));
    const detection = createLazyDetection({
      load,
      create: (m) =>
        m.createDetection(
          {
            homeRegions: [],
            preferredRegions: [],
            entityTypes: new Set(),
            idPacks: {},
          },
          { now: () => 0, yieldNow: () => Promise.resolve() },
        ),
    });
    expect(detection.current()).toBeNull();
    const [a, b] = await Promise.all([detection.ready(), detection.ready()]);
    expect(a).toBe(runtime);
    expect(b).toBe(runtime);
    expect(load).toHaveBeenCalledTimes(1);
    expect(detection.current()).toBe(runtime);
  });

  it('makes a caller wait until the module has loaded', async () => {
    const { load, resolve } = controllableLoad();
    const runtime = fakeRuntime();
    const detection = createLazyDetection({ load, create: () => runtime });
    let settled = false;
    const waiting = detection.ready().then((r) => {
      settled = true;
      return r;
    });
    await flush();
    expect(settled).toBe(false);
    resolve(fakeModule(runtime));
    await expect(waiting).resolves.toBe(runtime);
  });

  it('rejects when the module fails to load, and tries again next time', async () => {
    const runtime = fakeRuntime();
    const load = vi
      .fn<() => Promise<unknown>>()
      .mockRejectedValueOnce(
        new TypeError('Failed to fetch dynamically imported module'),
      )
      .mockResolvedValueOnce(fakeModule(runtime));
    const detection = createLazyDetection({ load, create: () => runtime });
    const failed = detection.ready();
    await expect(failed).rejects.toBeInstanceOf(DetectionLoadError);
    await expect(failed).rejects.toMatchObject({ reason: 'load-failed' });
    await expect(detection.ready()).resolves.toBe(runtime);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('rejects after the timeout', async () => {
    vi.useFakeTimers();
    const { load } = controllableLoad();
    const detection = createLazyDetection({
      load,
      create: () => fakeRuntime(),
      timeoutMs: 1000,
    });
    const waiting = detection.ready();
    const check = expect(waiting).rejects.toMatchObject({
      reason: 'load-timeout',
    });
    await vi.advanceTimersByTimeAsync(1000);
    await check;
  });

  it('rejects a module of another shape or version', async () => {
    for (const module of [
      {},
      { DETECTION_API_VERSION: 2, createDetection: () => fakeRuntime() },
      null,
    ]) {
      const detection = createLazyDetection({
        load: () => Promise.resolve(module),
        create: () => fakeRuntime(),
      });
      await expect(detection.ready()).rejects.toMatchObject({
        reason: 'invalid-module',
      });
    }
  });

  it('disposes the runtime and refuses later work', async () => {
    const dispose = vi.fn();
    const runtime = { ...fakeRuntime(), dispose };
    const detection = createLazyDetection({
      load: () => Promise.resolve(fakeModule(runtime)),
      create: () => runtime,
    });
    await detection.ready();
    detection.dispose();
    expect(dispose).toHaveBeenCalledTimes(1);
    await expect(detection.ready()).rejects.toMatchObject({
      reason: 'disposed',
    });
  });

  it('start() reports a failure without an unhandled rejection', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const detection = createLazyDetection({
      load: () => Promise.reject(new Error('missing')),
      create: () => fakeRuntime(),
    });
    detection.start();
    await flush();
    expect(
      info.mock.calls
        .map((c) => String(c[0]))
        .some((l) => l.includes('detection.failed load-failed')),
    ).toBe(true);
    info.mockRestore();
  });
});

describe('a Send before detection is ready', () => {
  const readyNet: NetBridge = {
    isReady: () => true,
    onReady: (callback) => {
      callback();
    },
    sync: () => undefined,
  };

  function start(load: () => Promise<unknown>) {
    const h = setUp();
    const runtime = fakeRuntime();
    const detection = createLazyDetection({
      load,
      create: () => runtime,
      timeoutMs: 1000,
    });
    const masker = createSpikeMasker({
      detect: async (text) => (await detection.ready()).analyse(text),
    });
    const controller = new AbortController();
    startInstance({
      adapter: h.adapter,
      transform: masker.transform,
      source: masker.source,
      net: readyNet,
      isContextValid: () => true,
      signal: controller.signal,
    });
    return { h, controller, runtime };
  }

  it('waits for the module, then sends the masked prompt', async () => {
    const { load, resolve } = controllableLoad();
    const { h, controller, runtime } = start(load);
    h.editor.textContent = 'Mail dana@example.com';
    pressKey(h.editor, { key: 'Enter' });
    await flush();
    await flush();
    expect(h.siteSends).toEqual([]);
    resolve(fakeModule(runtime));
    await flush();
    await flush();
    expect(h.siteSends).toEqual(['Mail standin.1@example.net']);
    controller.abort();
  });

  it('is blocked when the module fails to load', async () => {
    const { load, reject } = controllableLoad();
    const { h, controller } = start(load);
    h.editor.textContent = 'Mail dana@example.com';
    pressKey(h.editor, { key: 'Enter' });
    await flush();
    reject(new TypeError('Failed to fetch dynamically imported module'));
    await flush();
    await flush();
    expect(h.siteSends).toEqual([]);
    expect(h.editor.textContent).toBe('Mail dana@example.com');
    controller.abort();
  });

  it('is blocked when loading times out', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { load } = controllableLoad();
    const { h, controller } = start(load);
    h.editor.textContent = 'Mail dana@example.com';
    pressKey(h.editor, { key: 'Enter' });
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(10);
    expect(h.siteSends).toEqual([]);
    expect(h.editor.textContent).toBe('Mail dana@example.com');
    controller.abort();
  });
});
