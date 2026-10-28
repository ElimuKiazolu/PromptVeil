import { builtinEnvironments } from 'vitest/runtime';

/**
 * Global setup of the dom project: builds and closes one jsdom window in the
 * main process before any test worker starts.
 *
 * Vitest gives a worker a fixed 60 s to report "started", and that window
 * includes loading the test environment. Reading jsdom's module files from a
 * cold file cache (after a reboot or heavy memory use) is many times slower
 * than a warm load on slow machines, so the first workers, loading jsdom
 * cold at the same time, can exceed the limit. Paying the cold read here,
 * where no start timeout applies, lets every worker load from a warm cache.
 *
 * The window is built through Vitest's own jsdom environment in a separate
 * context (`setupVM`), so the same modules the workers need are read, and
 * the main process's globals are left untouched.
 */
export default async function warmUpJsdom(): Promise<void> {
  const { setupVM } = builtinEnvironments.jsdom;
  if (setupVM === undefined) {
    throw new Error('jsdom environment has no setupVM; update the warm-up');
  }
  const environment = await setupVM({});
  await environment.teardown();
}
