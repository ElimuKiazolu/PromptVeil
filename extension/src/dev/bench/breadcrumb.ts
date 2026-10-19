/**
 * A run's last stage, saved before each step. JavaScript cannot catch the
 * browser killing the tab (e.g. "Aw, Snap!"), so after a reload the page
 * reads this to say which step the killed run had reached. Holds stage names
 * and settings only.
 */
import {
  describeConfig,
  describeStage,
  type BenchConfig,
  type BenchPath,
  type BenchStage,
  type StageDetail,
} from './protocol.ts';

export const BREADCRUMB_KEY = 'promptveil-bench:last-stage';

export interface Breadcrumb {
  path: BenchPath;
  config: BenchConfig;
  stage: BenchStage;
  detail?: StageDetail;
  /** Epoch milliseconds when the stage started. */
  at: number;
}

export type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export function saveBreadcrumb(storage: StorageLike, crumb: Breadcrumb): void {
  storage.setItem(BREADCRUMB_KEY, JSON.stringify(crumb));
}

export function clearBreadcrumb(storage: StorageLike): void {
  storage.removeItem(BREADCRUMB_KEY);
}

function isBreadcrumb(value: unknown): value is Breadcrumb {
  if (typeof value !== 'object' || value === null) return false;
  const crumb = value as Partial<Record<keyof Breadcrumb, unknown>>;
  return (
    (crumb.path === 'offscreen' || crumb.path === 'direct') &&
    typeof crumb.config === 'object' &&
    crumb.config !== null &&
    typeof crumb.stage === 'string' &&
    typeof crumb.at === 'number'
  );
}

/** The unfinished run's breadcrumb, or null if the last run finished. */
export function readBreadcrumb(storage: StorageLike): Breadcrumb | null {
  const raw = storage.getItem(BREADCRUMB_KEY);
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Not ours or corrupted: it cannot describe a run, so it is dropped.
    clearBreadcrumb(storage);
    return null;
  }
  if (!isBreadcrumb(parsed)) {
    clearBreadcrumb(storage);
    return null;
  }
  return parsed;
}

export function describeBreadcrumb(crumb: Breadcrumb): string {
  return `The previous run (${describeConfig(crumb.config, crumb.path)}) did not finish. It was at: ${describeStage(crumb.stage, crumb.detail)}, started ${new Date(crumb.at).toLocaleTimeString()}. The tab or extension was most likely killed by the browser during that step.`;
}
