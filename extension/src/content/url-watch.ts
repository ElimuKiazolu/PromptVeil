/**
 * Notices URL changes made by the page itself (single-page navigation, e.g.
 * opening another chat, or a new chat receiving its ID).
 *
 * Uses the Navigation API where the browser has it: `currententrychange`
 * fires after the URL changed, `navigate` just before (checked again in the
 * next task). Without it, the URL is polled. Callers re-read the URL
 * themselves, so extra calls are harmless.
 */

export interface UrlWatchOptions {
  onChange: () => void;
  signal: AbortSignal;
  target?: Window;
  /** Poll interval when the Navigation API is missing. */
  pollMs?: number;
}

const DEFAULT_POLL_MS = 500;

/** `window.navigation`, which the TypeScript DOM library does not declare yet. */
function navigationOf(target: Window): EventTarget | null {
  const navigation: unknown = Reflect.get(target, 'navigation');
  return navigation instanceof EventTarget ? navigation : null;
}

export function watchUrlChanges({
  onChange,
  signal,
  target = window,
  pollMs = DEFAULT_POLL_MS,
}: UrlWatchOptions): void {
  if (signal.aborted) return;
  const navigation = navigationOf(target);
  if (navigation === null) {
    const timer = setInterval(onChange, pollMs);
    signal.addEventListener(
      'abort',
      () => {
        clearInterval(timer);
      },
      { once: true },
    );
    return;
  }
  navigation.addEventListener('currententrychange', onChange, { signal });
  navigation.addEventListener(
    'navigate',
    () => {
      setTimeout(() => {
        if (!signal.aborted) onChange();
      }, 0);
    },
    { signal },
  );
}
