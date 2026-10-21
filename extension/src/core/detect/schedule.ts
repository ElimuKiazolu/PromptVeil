/**
 * Cooperative scheduling for detection work that can take longer than one
 * frame (the first all-region phone check, long prompts).
 *
 * Work is written as steps; a checkpoint between steps gives the main thread
 * back once the current slice has run for `sliceMs`. The host supplies the
 * clock and the way to yield, so this module stays free of timers and
 * browser APIs.
 */

export interface Yielder {
  /** Milliseconds from a monotonic clock. */
  now(): number;
  /** Resolves in a later task, letting the event loop run in between. */
  yieldNow(): Promise<void>;
}

/**
 * Called between steps. Returns undefined when work may continue in the same
 * task, or a promise to await first. Throws (or rejects) with the signal's
 * reason once the work is cancelled.
 */
export type Checkpoint = () => Promise<void> | undefined;

/**
 * One slice of at most ~8 ms plus a single step keeps every task well under
 * the 16 ms frame budget on the target laptop.
 */
export const DEFAULT_SLICE_MS = 8;

/** A checkpoint that never yields; for callers that may block (tests, scripts). */
export function blockingCheckpoint(signal?: AbortSignal): Checkpoint {
  return () => {
    signal?.throwIfAborted();
    return undefined;
  };
}

export function createCheckpoint(
  yielder: Yielder,
  options: { sliceMs?: number; signal?: AbortSignal } = {},
): Checkpoint {
  const { sliceMs = DEFAULT_SLICE_MS, signal } = options;
  let sliceStart = yielder.now();
  const resume = (): void => {
    sliceStart = yielder.now();
    signal?.throwIfAborted();
  };
  return () => {
    signal?.throwIfAborted();
    if (yielder.now() - sliceStart < sliceMs) return undefined;
    return yielder.yieldNow().then(resume);
  };
}

/** Runs step-wise work to completion in the current task. */
export function runBlocking<T>(steps: Generator<void, T>): T {
  let step = steps.next();
  while (step.done !== true) step = steps.next();
  return step.value;
}

/** Runs step-wise work, calling the checkpoint between steps. */
export async function runSliced<T>(
  steps: Generator<void, T>,
  checkpoint: Checkpoint,
): Promise<T> {
  let step = steps.next();
  while (step.done !== true) {
    const pending = checkpoint();
    if (pending !== undefined) await pending;
    step = steps.next();
  }
  return step.value;
}
