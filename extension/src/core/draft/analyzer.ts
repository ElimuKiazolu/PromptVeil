/**
 * Draft analysis: one path that analyses a prompt while it is being written
 * and again at Send.
 *
 * - prepare(text): background pre-pass while typing or after a paste. A newer
 *   draft cancels an older pre-pass at its next checkpoint. Its result is
 *   cached, and its side caches (the phone all-region results) warm up.
 * - analyse(text): the Send path. Returns the cached result for exactly this
 *   text, joins a run already in progress for it, or runs now. A Send is
 *   never cancelled by a newer draft.
 *
 * Results hold real values: memory only, a few entries, wiped by clear()
 * (page hidden) and dispose() (instance torn down).
 *
 * The analysis function is the extension point: rules now; the NER model
 * (P7) adds its sentence-keyed work inside the same function, so typing,
 * paste and Send share one cache and one cancellation path.
 */
import {
  createCheckpoint,
  type Checkpoint,
  type Yielder,
} from '../detect/schedule.ts';

export type Analyse<R> = (text: string, checkpoint: Checkpoint) => Promise<R>;

export interface DraftAnalyzerOptions<R> {
  analyse: Analyse<R>;
  yielder: Yielder;
  /** Called by clear() and dispose(), e.g. to wipe validator caches. */
  onClear?: () => void;
  /** Results kept, most recent first out last. */
  cacheSize?: number;
  sliceMs?: number;
}

export interface DraftAnalyzer<R> {
  /** Starts a background pre-pass for this draft. */
  prepare(text: string): Promise<void>;
  /** The analysis of exactly this text, for Send. */
  analyse(text: string): Promise<R>;
  /** Forgets every cached result and cancels pre-passes. */
  clear(): void;
  /** clear(), and refuses all later work. */
  dispose(): void;
}

interface Run<R> {
  text: string;
  controller: AbortController;
  promise: Promise<R>;
  /** A Send waits for this run: never cancel it. */
  needed: boolean;
}

const DEFAULT_CACHE_SIZE = 4;

export class DraftAnalyzerDisposedError extends Error {
  constructor() {
    super('draft analyzer disposed');
    this.name = 'DraftAnalyzerDisposedError';
  }
}

export function createDraftAnalyzer<R>({
  analyse,
  yielder,
  onClear,
  cacheSize = DEFAULT_CACHE_SIZE,
  sliceMs,
}: DraftAnalyzerOptions<R>): DraftAnalyzer<R> {
  // Boxed so a result that is itself undefined is still a hit.
  const results = new Map<string, { result: R }>();
  const runs = new Set<Run<R>>();
  let disposed = false;

  const remember = (text: string, result: R): void => {
    results.delete(text);
    results.set(text, { result });
    while (results.size > cacheSize) {
      const oldest = results.keys().next();
      if (oldest.done === true) break;
      results.delete(oldest.value);
    }
  };

  const start = (text: string, needed: boolean): Run<R> => {
    const controller = new AbortController();
    const checkpoint = createCheckpoint(yielder, {
      signal: controller.signal,
      ...(sliceMs === undefined ? {} : { sliceMs }),
    });
    const run: Run<R> = {
      text,
      controller,
      needed,
      promise: analyse(text, checkpoint).then(
        (result) => {
          runs.delete(run);
          // A result that finished after clear() must not come back.
          if (!controller.signal.aborted) remember(text, result);
          return result;
        },
        (error: unknown) => {
          runs.delete(run);
          throw error;
        },
      ),
    };
    runs.add(run);
    return run;
  };

  const cancelPrePasses = (except: string | null): void => {
    for (const run of runs) {
      if (!run.needed && run.text !== except) {
        run.controller.abort();
        runs.delete(run);
      }
    }
  };

  const cached = (text: string): { result: R } | undefined => {
    const hit = results.get(text);
    if (hit !== undefined) remember(text, hit.result);
    return hit;
  };

  const clear = (): void => {
    for (const run of runs) run.controller.abort();
    runs.clear();
    results.clear();
    onClear?.();
  };

  return {
    async prepare(text) {
      if (disposed) throw new DraftAnalyzerDisposedError();
      cancelPrePasses(text);
      if (results.has(text)) return;
      for (const run of runs) if (run.text === text) return;
      const run = start(text, false);
      try {
        await run.promise;
      } catch (error) {
        // Superseded by a newer draft or cleared: nothing to report.
        if (run.controller.signal.aborted) return;
        throw error;
      }
    },

    analyse(text) {
      if (disposed) return Promise.reject(new DraftAnalyzerDisposedError());
      const hit = cached(text);
      if (hit !== undefined) return Promise.resolve(hit.result);
      for (const run of runs) {
        if (run.text === text) {
          run.needed = true;
          return run.promise;
        }
      }
      return start(text, true).promise;
    },

    clear,

    dispose() {
      disposed = true;
      clear();
    },
  };
}
