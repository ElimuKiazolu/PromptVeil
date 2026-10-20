import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import {
  DEFAULT_TIMEOUT_MS,
  PROTOCOL,
  createMessenger,
  type MessageSenderLike,
  type ProtocolSpec,
  type RuntimeLike,
  type RuntimeListener,
} from '@/src/shared/messaging.ts';

interface TestProtocol {
  add: { request: { a: number; b: number }; response: { sum: number } };
  ping: { request: null; response: 'pong' };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const SPEC: ProtocolSpec<TestProtocol> = {
  add: {
    request: (value): value is { a: number; b: number } =>
      isRecord(value) &&
      typeof value.a === 'number' &&
      typeof value.b === 'number',
    response: (value): value is { sum: number } =>
      isRecord(value) && typeof value.sum === 'number',
  },
  ping: {
    request: (value): value is null => value === null,
    response: (value): value is 'pong' => value === 'pong',
  },
};

const EXTENSION_ID = 'abcdefghijklmnopabcdefghijklmnop';

/**
 * Contexts of one extension sharing a message bus, as in Chromium: a message
 * goes to every other context's listeners; the first reply wins; with no
 * listener at all it rejects; with listeners that all stay silent it resolves
 * undefined.
 */
class Bus {
  readonly contexts: FakeRuntime[] = [];

  context(sender: MessageSenderLike = { id: EXTENSION_ID }): FakeRuntime {
    const runtime = new FakeRuntime(this, sender);
    this.contexts.push(runtime);
    return runtime;
  }

  deliver(from: FakeRuntime, message: unknown): Promise<unknown> {
    const listeners = this.contexts
      .filter((context) => context !== from)
      .flatMap((context) => [...context.listeners]);
    if (listeners.length === 0) {
      return Promise.reject(
        new Error(
          'Could not establish connection. Receiving end does not exist.',
        ),
      );
    }
    return new Promise((resolve) => {
      const state = { pending: false, answered: false };
      const sendResponse = (response: unknown): void => {
        if (state.answered) return;
        state.answered = true;
        resolve(response);
      };
      for (const listener of listeners) {
        // Each listener gets its own copy, as structured cloning would give.
        const result = listener(
          structuredClone(message),
          from.sender,
          sendResponse,
        );
        if (result === true) state.pending = true;
      }
      if (!state.pending && !state.answered) resolve(undefined);
    });
  }
}

class FakeRuntime implements RuntimeLike {
  readonly listeners = new Set<RuntimeListener>();
  id: string | undefined = EXTENSION_ID;
  readonly sendMessage = vi.fn((message: unknown): Promise<unknown> =>
    this.bus.deliver(this, message),
  );
  readonly onMessage = {
    addListener: (listener: RuntimeListener): void => {
      this.listeners.add(listener);
    },
    removeListener: (listener: RuntimeListener): void => {
      this.listeners.delete(listener);
    },
  };

  private readonly bus: Bus;
  readonly sender: MessageSenderLike;

  constructor(bus: Bus, sender: MessageSenderLike) {
    this.bus = bus;
    this.sender = sender;
  }
}

function setup() {
  const bus = new Bus();
  const contentRuntime = bus.context({
    id: EXTENSION_ID,
    tab: { id: 7 },
    frameId: 0,
  });
  const backgroundRuntime = bus.context();
  return {
    bus,
    contentRuntime,
    backgroundRuntime,
    content: createMessenger(SPEC, contentRuntime),
    background: createMessenger(SPEC, backgroundRuntime),
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('createMessenger', () => {
  it('round-trips a typed request and response', async () => {
    const { content, background } = setup();
    background.handle('add', ({ a, b }) => ({ sum: a + b }));
    await expect(content.send('add', { a: 2, b: 3 })).resolves.toEqual({
      ok: true,
      value: { sum: 5 },
    });
  });

  it('supports asynchronous handlers and passes the sender', async () => {
    const { content, background } = setup();
    const seen: MessageSenderLike[] = [];
    background.handle('ping', async (_request, sender): Promise<'pong'> => {
      seen.push(sender);
      await Promise.resolve();
      return 'pong';
    });
    await expect(content.send('ping', null)).resolves.toEqual({
      ok: true,
      value: 'pong',
    });
    expect(seen).toEqual([{ id: EXTENSION_ID, tab: { id: 7 }, frameId: 0 }]);
  });

  it('times out when no reply arrives', async () => {
    vi.useFakeTimers();
    const { content, background } = setup();
    background.handle('ping', () => new Promise<'pong'>(() => undefined));
    const result = content.send('ping', null, { timeoutMs: 1000 });
    await vi.advanceTimersByTimeAsync(999);
    let settled = false;
    void result.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toEqual({ ok: false, error: 'timeout' });
  });

  it('uses the default timeout when none is given', async () => {
    vi.useFakeTimers();
    const { content, background } = setup();
    background.handle('ping', () => new Promise<'pong'>(() => undefined));
    const result = content.send('ping', null);
    await vi.advanceTimersByTimeAsync(DEFAULT_TIMEOUT_MS);
    await expect(result).resolves.toEqual({ ok: false, error: 'timeout' });
  });

  it('reports a handler that throws or rejects as handler-failed', async () => {
    const { content, background } = setup();
    background.handle('add', () => {
      throw new Error('boom');
    });
    background.handle('ping', () => Promise.reject(new Error('boom')));
    await expect(content.send('add', { a: 1, b: 1 })).resolves.toEqual({
      ok: false,
      error: 'handler-failed',
    });
    await expect(content.send('ping', null)).resolves.toEqual({
      ok: false,
      error: 'handler-failed',
    });
  });

  it('does not send a malformed handler response', async () => {
    const { content, background } = setup();
    // Simulates a handler bug that the types would normally prevent.
    const loose = background as unknown as {
      handle(name: string, handler: () => unknown): () => void;
    };
    loose.handle('ping', () => 'pang');
    await expect(content.send('ping', null)).resolves.toEqual({
      ok: false,
      error: 'handler-failed',
    });
  });

  it('rejects a request that fails its shape check without calling the handler', async () => {
    const { content, background } = setup();
    const handler = vi.fn(() => ({ sum: 0 }));
    background.handle('add', handler);
    const loose = content as unknown as {
      send(name: string, request: unknown): Promise<unknown>;
    };
    await expect(loose.send('add', { a: '1', b: 2 })).resolves.toEqual({
      ok: false,
      error: 'rejected',
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it('ignores messages from another extension', async () => {
    const bus = new Bus();
    const foreign = bus.context({ id: 'another-extension-id-000000000000' });
    const backgroundRuntime = bus.context();
    const background = createMessenger(SPEC, backgroundRuntime);
    const handler = vi.fn(() => 'pong' as const);
    background.handle('ping', handler);
    const result = await createMessenger(SPEC, foreign).send('ping', null);
    expect(result).toEqual({ ok: false, error: 'no-receiver' });
    expect(handler).not.toHaveBeenCalled();
  });

  it('ignores everything once its own context is invalidated', async () => {
    const { content, background, backgroundRuntime } = setup();
    const handler = vi.fn(() => 'pong' as const);
    background.handle('ping', handler);
    backgroundRuntime.id = undefined;
    await expect(content.send('ping', null)).resolves.toEqual({
      ok: false,
      error: 'no-receiver',
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it('leaves messages outside its envelope and names it does not handle to others', () => {
    const { background, backgroundRuntime } = setup();
    background.handle('ping', () => 'pong');
    const [listener] = [...backgroundRuntime.listeners];
    if (!listener) throw new Error('listener not registered');
    const sendResponse = vi.fn();
    const sender = { id: EXTENSION_ID };
    expect(listener({ type: 'other' }, sender, sendResponse)).toBeUndefined();
    expect(listener('text', sender, sendResponse)).toBeUndefined();
    expect(
      listener(
        { channel: 'promptveil/1', name: 'add', request: { a: 1, b: 1 } },
        sender,
        sendResponse,
      ),
    ).toBeUndefined();
    expect(sendResponse).not.toHaveBeenCalled();
  });

  it('lets the context that handles a name answer when several listen', async () => {
    const { bus, content, background } = setup();
    const offscreen = createMessenger(SPEC, bus.context());
    background.handle('ping', () => 'pong');
    offscreen.handle('add', ({ a, b }) => ({ sum: a * 10 + b }));
    await expect(content.send('add', { a: 1, b: 2 })).resolves.toEqual({
      ok: true,
      value: { sum: 12 },
    });
    await expect(content.send('ping', null)).resolves.toEqual({
      ok: true,
      value: 'pong',
    });
  });

  it('reports no-receiver when every listener stays silent', async () => {
    const { content, background } = setup();
    background.handle('add', () => ({ sum: 0 }));
    await expect(content.send('ping', null)).resolves.toEqual({
      ok: false,
      error: 'no-receiver',
    });
  });

  it('reports send-failed when delivery is refused', async () => {
    const { content } = setup();
    // No context listens at all: Chromium rejects.
    await expect(content.send('ping', null)).resolves.toEqual({
      ok: false,
      error: 'send-failed',
    });
  });

  it('reports context-invalidated from an orphaned script, including a synchronous throw', async () => {
    const { content, contentRuntime } = setup();
    contentRuntime.id = undefined;
    contentRuntime.sendMessage.mockImplementationOnce(() => {
      throw new Error('Extension context invalidated.');
    });
    await expect(content.send('ping', null)).resolves.toEqual({
      ok: false,
      error: 'context-invalidated',
    });
    contentRuntime.sendMessage.mockImplementationOnce(() =>
      Promise.reject(new Error('Extension context invalidated.')),
    );
    await expect(content.send('ping', null)).resolves.toEqual({
      ok: false,
      error: 'context-invalidated',
    });
  });

  it('rejects malformed replies', async () => {
    const { content, contentRuntime } = setup();
    for (const reply of [
      'pong',
      { ok: true, response: 'pong' },
      { channel: 'promptveil/1', ok: false, error: 'other' },
      { channel: 'promptveil/1', ok: true },
      { channel: 'promptveil/1', ok: true, response: 'pang' },
    ]) {
      contentRuntime.sendMessage.mockResolvedValueOnce(reply);
      await expect(content.send('ping', null)).resolves.toEqual({
        ok: false,
        error: 'invalid-response',
      });
    }
  });

  it('never rejects, whatever the runtime does', async () => {
    const { content, contentRuntime } = setup();
    contentRuntime.sendMessage.mockImplementationOnce(() => {
      throw new TypeError('not serialisable');
    });
    await expect(content.send('ping', null)).resolves.toEqual({
      ok: false,
      error: 'send-failed',
    });
  });

  it('allows one handler per name and removes the listener with the last one', () => {
    const { background, backgroundRuntime } = setup();
    const offPing = background.handle('ping', () => 'pong');
    expect(() => background.handle('ping', () => 'pong')).toThrow(
      'already registered',
    );
    const offAdd = background.handle('add', () => ({ sum: 0 }));
    expect(backgroundRuntime.listeners.size).toBe(1);
    offPing();
    offPing();
    expect(backgroundRuntime.listeners.size).toBe(1);
    offAdd();
    expect(backgroundRuntime.listeners.size).toBe(0);
    background.handle('ping', () => 'pong');
    expect(backgroundRuntime.listeners.size).toBe(1);
  });
});

describe('production protocol', () => {
  it('is empty until a feature adds messages', () => {
    expect(Object.keys(PROTOCOL)).toEqual([]);
  });

  it('accepts the WXT runtime as its runtime', () => {
    expectTypeOf<typeof browser.runtime>().toExtend<RuntimeLike>();
  });
});
