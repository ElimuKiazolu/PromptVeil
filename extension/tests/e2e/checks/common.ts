import type { Harness } from '../support/browser.ts';
import { compact } from '../support/values.ts';

export interface Check {
  /** Stable id, used by --only. */
  readonly id: string;
  /** What it confirms. */
  readonly title: string;
  /** Phase that added it. */
  readonly phase: string;
  /** Throws on failure; may return a short note (timings, path taken). */
  run(h: Harness): Promise<string | undefined>;
}

export function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

/** Undoes the escapes a request body may carry (for the audit's search). */
export function unescapeBody(text: string): string {
  return text
    .replace(/&#x([0-9a-f]+);?/gi, (_m, hex: string) =>
      String.fromCodePoint(parseInt(hex, 16)),
    )
    .replace(/&#(\d+);?/g, (_m, dec: string) =>
      String.fromCodePoint(parseInt(dec, 10)),
    )
    .replaceAll('&nbsp;', ' ')
    .replaceAll(String.fromCharCode(92), '');
}

/** True when `text` carries `value` in any spacing, case or punctuation. */
export function carries(text: string, value: string): boolean {
  return compact(unescapeBody(text)).includes(compact(value));
}

/** Throws when the text the site received carries any real value. */
export function assertNoReal(
  text: string,
  values: readonly string[],
  where: string,
): void {
  const found = values.filter((value) => carries(text, value));
  assert(
    found.length === 0,
    `${found.length.toString()} real value(s) reached the site in ${where}`,
  );
}

/** Median and p95 of a list of numbers, formatted. */
export function stats(values: readonly number[]): string {
  if (values.length === 0) return 'n=0';
  const sorted = [...values].sort((a, b) => a - b);
  const at = (p: number): number =>
    sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? 0;
  return `${at(0.5).toFixed(1)}/${at(0.95).toFixed(1)}`;
}

interface Closable {
  isClosed(): boolean;
  close(): Promise<void>;
}

/**
 * Runs `body`, then closes every tab it registered with `track`, so a check
 * leaves no tab behind. A failure of the body is reported before any
 * failure to close.
 */
export async function withTabs<T>(
  body: (track: <P extends Closable>(tab: P) => P) => Promise<T>,
): Promise<T> {
  const open: Closable[] = [];
  const closeAll = async (): Promise<void> => {
    for (const tab of open) if (!tab.isClosed()) await tab.close();
  };
  let result: T;
  try {
    result = await body((tab) => {
      open.push(tab);
      return tab;
    });
  } catch (error) {
    await closeAll().then(
      () => undefined,
      (closeError: unknown) => {
        throw new AggregateError([error, closeError], String(error));
      },
    );
    throw error;
  }
  await closeAll();
  return result;
}
