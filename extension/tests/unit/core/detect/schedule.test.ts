import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_SLICE_MS,
  blockingCheckpoint,
  createCheckpoint,
  runBlocking,
  runSliced,
  type Yielder,
} from '@/src/core/detect/schedule.ts';

/** A clock the test moves by hand; each yield is counted. */
function fakeYielder() {
  const state = { now: 0, yields: 0 };
  const yielder: Yielder = {
    now: () => state.now,
    yieldNow: () => {
      state.yields += 1;
      return Promise.resolve();
    },
  };
  return { state, yielder };
}

function* steps(count: number, onStep: () => void): Generator<void, number> {
  for (let i = 0; i < count; i += 1) {
    onStep();
    yield;
  }
  return count;
}

describe('createCheckpoint', () => {
  it('continues in the same task until the slice is used up', async () => {
    const { state, yielder } = fakeYielder();
    const checkpoint = createCheckpoint(yielder, { sliceMs: 8 });
    state.now = 7;
    expect(checkpoint()).toBeUndefined();
    state.now = 8;
    const pending = checkpoint();
    expect(pending).toBeInstanceOf(Promise);
    await pending;
    expect(state.yields).toBe(1);
    // A new slice starts after the yield.
    state.now = 15;
    expect(checkpoint()).toBeUndefined();
  });

  it('uses an 8 ms slice by default', () => {
    expect(DEFAULT_SLICE_MS).toBe(8);
  });

  it('throws once the signal is aborted, before and after a yield', async () => {
    const { state, yielder } = fakeYielder();
    const controller = new AbortController();
    const checkpoint = createCheckpoint(yielder, { signal: controller.signal });
    state.now = 100;
    const pending = checkpoint();
    controller.abort(new Error('superseded'));
    await expect(pending).rejects.toThrow('superseded');
    expect(() => checkpoint()).toThrow('superseded');
  });
});

describe('blockingCheckpoint', () => {
  it('never yields and honours the signal', () => {
    const controller = new AbortController();
    const checkpoint = blockingCheckpoint(controller.signal);
    expect(checkpoint()).toBeUndefined();
    controller.abort(new Error('stop'));
    expect(() => checkpoint()).toThrow('stop');
  });
});

describe('runBlocking / runSliced', () => {
  it('run every step and return the result', async () => {
    const onStep = vi.fn();
    expect(runBlocking(steps(5, onStep))).toBe(5);
    expect(onStep).toHaveBeenCalledTimes(5);
    await expect(
      runSliced(steps(3, onStep), blockingCheckpoint()),
    ).resolves.toBe(3);
  });

  it('yields between steps whenever the slice is used up', async () => {
    const { state, yielder } = fakeYielder();
    const checkpoint = createCheckpoint(yielder, { sliceMs: 8 });
    // Each step takes 3 ms: a yield after every third step.
    await runSliced(
      steps(9, () => {
        state.now += 3;
      }),
      checkpoint,
    );
    expect(state.yields).toBe(3);
  });
});
