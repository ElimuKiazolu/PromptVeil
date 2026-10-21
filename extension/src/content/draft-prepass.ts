import type { Composer, SiteAdapter } from '@/src/adapters/types.ts';
import { devlog } from '@/src/shared/devlog.ts';

export interface DraftPrepassOptions {
  adapter: SiteAdapter;
  /** Starts the background analysis of a draft. */
  prepare: (text: string) => Promise<void>;
  /** Removes every listener and pending timer when aborted. */
  signal: AbortSignal;
  target?: Window;
  /** Pause in typing before the draft is analysed. */
  pauseMs?: number;
}

export const DEFAULT_PAUSE_MS = 300;

/**
 * Analyses the draft in any composer while the user writes it, so Send finds
 * the work done: after a pause in typing, and straight after a paste or drop
 * (the editor has inserted the content by the next task).
 *
 * Best effort only: a failure here is logged and the Send path analyses the
 * prompt itself, exactly and failing closed.
 */
export function startDraftPrepass({
  adapter,
  prepare,
  signal,
  target = window,
  pauseMs = DEFAULT_PAUSE_MS,
}: DraftPrepassOptions): void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: Composer | null = null;

  const run = (): void => {
    timer = undefined;
    const composer = pending;
    pending = null;
    if (composer === null || signal.aborted) return;
    let text: string;
    try {
      text = composer.readPrompt();
    } catch (error) {
      devlog('prepass.failed', { error });
      return;
    }
    if (text.trim().length === 0) return;
    prepare(text).catch((error: unknown) => {
      devlog('prepass.failed', { error });
    });
  };

  const schedule = (event: Event, delay: number): void => {
    const composer = adapter.composerFor(event.target);
    if (composer === null) return;
    pending = composer;
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(run, delay);
  };

  const options = { capture: true, signal };
  target.addEventListener(
    'input',
    (event) => {
      schedule(event, pauseMs);
    },
    options,
  );
  for (const type of ['paste', 'drop'] as const) {
    target.addEventListener(
      type,
      (event) => {
        schedule(event, 0);
      },
      options,
    );
  }
  signal.addEventListener(
    'abort',
    () => {
      if (timer !== undefined) clearTimeout(timer);
      pending = null;
    },
    { once: true },
  );
}
