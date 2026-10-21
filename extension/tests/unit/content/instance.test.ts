import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startInstance } from '@/src/content/instance.ts';
import type { NetBridge } from '@/src/content/net-bridge.ts';
import type { PromptTransform } from '@/src/content/interceptor.ts';
import { createSpikeMasker } from '@/src/core/spike-mask.ts';
import { flush, pressKey, setUp, type Harness } from './harness.ts';

interface TestInstance {
  /** Simulates the framework invalidating the content script. */
  frameworkAbort: AbortController;
  transform: ReturnType<typeof vi.fn<PromptTransform>>;
  setContextValid: (valid: boolean) => void;
}

const HEARTBEAT_MS = 2000;

/** A request safety net that is already confirmed. */
const readyNet: NetBridge = {
  isReady: () => true,
  onReady: (callback) => {
    callback();
  },
  sync: () => undefined,
};

describe('startInstance', () => {
  let h: Harness;
  const started: TestInstance[] = [];

  const start = (
    transform?: PromptTransform,
    net: NetBridge = readyNet,
  ): TestInstance => {
    const masker = createSpikeMasker();
    let valid = true;
    const instance: TestInstance = {
      frameworkAbort: new AbortController(),
      transform: vi.fn(transform ?? masker.transform),
      setContextValid: (next) => {
        valid = next;
      },
    };
    startInstance({
      adapter: h.adapter,
      transform: instance.transform,
      source: masker.source,
      net,
      isContextValid: () => valid,
      signal: instance.frameworkAbort.signal,
      heartbeatMs: HEARTBEAT_MS,
    });
    started.push(instance);
    return instance;
  };

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    h = setUp();
  });

  afterEach(() => {
    for (const instance of started.splice(0)) instance.frameworkAbort.abort();
    vi.useRealTimers();
  });

  it('masks and sends while the extension context is alive', async () => {
    start();
    h.editor.textContent = 'Test dana@example.com';
    pressKey(h.editor, { key: 'Enter' });
    await flush();
    expect(h.siteSends).toEqual(['Test standin.1@example.net']);
  });

  it('falls back to the guard when a send finds the context gone', async () => {
    const instance = start();
    instance.setContextValid(false);
    h.editor.textContent = 'Test dana@example.com';

    const enter = pressKey(h.editor, { key: 'Enter' });
    await flush();
    expect(enter.defaultPrevented).toBe(true);
    expect(instance.transform).not.toHaveBeenCalled();

    // The guard keeps blocking afterwards, without the interceptor.
    const second = pressKey(h.editor, { key: 'Enter' });
    h.button.dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true }),
    );
    await flush();
    expect(second.defaultPrevented).toBe(true);
    expect(instance.transform).not.toHaveBeenCalled();
    expect(h.siteSends).toEqual([]);
  });

  it('detects an orphaned context on the heartbeat, before any send', async () => {
    const instance = start();
    instance.setContextValid(false);
    vi.advanceTimersByTime(HEARTBEAT_MS);
    // Even if the context check were to pass again, the guard stays.
    instance.setContextValid(true);

    h.editor.textContent = 'Test dana@example.com';
    const enter = pressKey(h.editor, { key: 'Enter' });
    await flush();
    expect(enter.defaultPrevented).toBe(true);
    expect(instance.transform).not.toHaveBeenCalled();
    expect(h.siteSends).toEqual([]);
  });

  it('does not send when the context is lost mid-send', async () => {
    const instance: TestInstance = start((text) => {
      instance.setContextValid(false);
      return createSpikeMasker().transform(text);
    });
    h.editor.textContent = 'Test dana@example.com';
    pressKey(h.editor, { key: 'Enter' });
    await flush();
    expect(h.siteSends).toEqual([]);
    expect(h.editor.textContent).toBe('Test dana@example.com');
  });

  it('falls back to the guard when the framework invalidates it', async () => {
    const instance = start();
    instance.frameworkAbort.abort();
    h.editor.textContent = 'Test dana@example.com';
    pressKey(h.editor, { key: 'Enter' });
    await flush();
    expect(instance.transform).not.toHaveBeenCalled();
    expect(h.siteSends).toEqual([]);
  });

  it('never lets two instances act on the same send', async () => {
    const older = start();
    const newer = start();
    h.editor.textContent = 'Test dana@example.com';
    pressKey(h.editor, { key: 'Enter' });
    await flush();

    expect(older.transform).not.toHaveBeenCalled();
    expect(newer.transform).toHaveBeenCalledTimes(1);
    expect(h.triggered).toBe(1);
    // The older instance's guard blocks the send: it cannot tell a real
    // newer instance from a forged one, so the tab waits for a reload.
    expect(h.siteSends).toEqual([]);
  });

  it('retires into the guard when a page script forges an instance start', async () => {
    const instance = start();
    window.dispatchEvent(new Event('promptveil:instance-started'));
    h.editor.textContent = 'Test dana@example.com';
    const enter = pressKey(h.editor, { key: 'Enter' });
    await flush();
    expect(enter.defaultPrevented).toBe(true);
    expect(instance.transform).not.toHaveBeenCalled();
    expect(h.siteSends).toEqual([]);
  });

  it('cannot be returned to unprotected sending by forged events', async () => {
    const instance = start();
    instance.setContextValid(false);
    vi.advanceTimersByTime(HEARTBEAT_MS);
    instance.setContextValid(true);

    for (const type of [
      'promptveil:instance-started',
      'promptveil:interceptor-ready',
      'promptveil:interceptor-ping',
      'promptveil:instance-alive',
    ]) {
      window.dispatchEvent(new Event(type));
    }
    h.editor.textContent = 'Test dana@example.com';
    pressKey(h.editor, { key: 'Enter' });
    h.button.click();
    h.form.dispatchEvent(
      new Event('submit', { bubbles: true, cancelable: true }),
    );
    await flush();
    expect(h.siteSends).toEqual([]);
  });

  it('restores real values while alive and stops once orphaned', async () => {
    const instance = start();
    h.editor.textContent = 'Test dana@example.com';
    pressKey(h.editor, { key: 'Enter' });
    await flush();

    // Fake intervals also drive jsdom's animation frames, so advance them.
    const nextFrame = async (): Promise<void> => {
      await Promise.resolve();
      const frame = new Promise<void>((done) => {
        requestAnimationFrame(() => {
          done();
        });
      });
      vi.advanceTimersByTime(50);
      await frame;
    };

    h.message.textContent = 'You wrote standin.1@example.net';
    await nextFrame();
    expect(h.message.textContent).toBe('You wrote dana@example.com');

    instance.setContextValid(false);
    vi.advanceTimersByTime(HEARTBEAT_MS);
    h.message.textContent = 'Again standin.1@example.net';
    await nextFrame();
    expect(h.message.textContent).toBe('Again standin.1@example.net');
  });

  it('blocks sends and holds back restoration until the net is confirmed', async () => {
    let ready = false;
    const waiting: (() => void)[] = [];
    const sync = vi.fn();
    const pendingNet: NetBridge = {
      isReady: () => ready,
      onReady: (callback) => {
        if (ready) callback();
        else waiting.push(callback);
      },
      sync,
    };
    const instance = start(undefined, pendingNet);

    h.editor.textContent = 'Test dana@example.com';
    const enter = pressKey(h.editor, { key: 'Enter' });
    await flush();
    expect(enter.defaultPrevented).toBe(true);
    expect(instance.transform).not.toHaveBeenCalled();
    expect(h.siteSends).toEqual([]);

    // Nothing is restored while the net is missing.
    h.message.textContent = 'standin.1@example.net';
    await Promise.resolve();
    vi.advanceTimersByTime(50);
    expect(h.message.textContent).toBe('standin.1@example.net');

    ready = true;
    for (const callback of waiting.splice(0)) callback();
    pressKey(h.editor, { key: 'Enter' });
    await flush();
    expect(h.siteSends).toEqual(['Test standin.1@example.net']);
    // The net learned the new mapping before the masked text was sent.
    expect(sync).toHaveBeenCalled();
    expect(sync.mock.calls.at(-1)?.[0]).toEqual([
      {
        standIn: 'standin.1@example.net',
        real: 'dana@example.com',
        boundary: 'email',
      },
    ]);
  });
});

describe('startInstance: draft pre-pass', () => {
  let h: Harness;
  let frameworkAbort: AbortController;
  let valid: boolean;
  const draft = {
    prepare: vi.fn<(text: string) => Promise<void>>(() => Promise.resolve()),
    clear: vi.fn(),
    dispose: vi.fn(),
  };

  beforeEach(() => {
    vi.useFakeTimers();
    h = setUp();
    frameworkAbort = new AbortController();
    valid = true;
    draft.prepare.mockClear();
    draft.clear.mockClear();
    draft.dispose.mockClear();
    const masker = createSpikeMasker();
    startInstance({
      adapter: h.adapter,
      transform: masker.transform,
      source: masker.source,
      net: readyNet,
      isContextValid: () => valid,
      signal: frameworkAbort.signal,
      draft,
      heartbeatMs: HEARTBEAT_MS,
    });
  });

  afterEach(() => {
    frameworkAbort.abort();
    vi.useRealTimers();
  });

  it('analyses drafts while the instance is alive', () => {
    h.editor.textContent = 'Mail dana@example.com';
    h.editor.dispatchEvent(new Event('input', { bubbles: true }));
    vi.advanceTimersByTime(300);
    expect(draft.prepare.mock.calls).toEqual([['Mail dana@example.com']]);
  });

  it('clears cached analyses when the page is hidden', () => {
    window.dispatchEvent(new Event('pagehide'));
    expect(draft.clear).toHaveBeenCalledTimes(1);
    expect(draft.dispose).not.toHaveBeenCalled();
  });

  it('disposes of the analyses and stops the pre-pass once orphaned', () => {
    valid = false;
    vi.advanceTimersByTime(HEARTBEAT_MS);
    expect(draft.dispose).toHaveBeenCalledTimes(1);
    h.editor.textContent = 'after';
    h.editor.dispatchEvent(new Event('input', { bubbles: true }));
    vi.advanceTimersByTime(300);
    expect(draft.prepare).not.toHaveBeenCalled();
  });
});
