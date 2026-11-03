/**
 * Auto-delete and delete-all, run by the service worker.
 *
 * Settings live in chrome.storage.local with one key per Settings field
 * (src/shared/settings.ts), so a single setting can be read without the
 * others and delete-all can keep exactly the `onboardingDone` key.
 */
import type { KeyState } from '@/src/core/vault/keys.ts';
import type { CleanupResult } from '@/src/core/vault/cleanup.ts';
import type { VaultService } from '@/src/core/vault/service.ts';
import { devlog } from '@/src/shared/devlog.ts';
import { DEFAULT_SETTINGS } from '@/src/shared/settings.ts';
import { notifyTabs, type TabsLike } from './tab-notices.ts';

/** The storage area API needed here; `browser.storage.local` satisfies it. */
export interface StorageAreaLike {
  get(keys: string | string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  clear(): Promise<void>;
}

/** The alarms API needed here; `browser.alarms` satisfies it. */
export interface AlarmsLike {
  get(name: string): Promise<{ name: string } | undefined>;
  create(
    name: string,
    info: { delayInMinutes: number; periodInMinutes: number },
  ): Promise<void>;
}

export const CLEANUP_ALARM = 'promptveil.cleanup';

const DAY_MINUTES = 24 * 60;

/** Longest retention a setting may hold (100 years); larger values are invalid. */
const MAX_RETENTION_DAYS = 36_500;

function isRetentionDays(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= MAX_RETENTION_DAYS
  );
}

/**
 * The retention setting, or the default when it is missing or malformed. A
 * storage failure rejects instead: guessing a value could delete mappings
 * the user chose to keep.
 */
export async function readRetentionDays(
  storage: StorageAreaLike,
): Promise<number> {
  const { retentionDays } = await storage.get('retentionDays');
  return isRetentionDays(retentionDays)
    ? retentionDays
    : DEFAULT_SETTINGS.retentionDays;
}

/** Schedules the daily cleanup unless it is already scheduled. */
export async function ensureCleanupAlarm(alarms: AlarmsLike): Promise<void> {
  if ((await alarms.get(CLEANUP_ALARM)) !== undefined) return;
  await alarms.create(CLEANUP_ALARM, {
    delayInMinutes: DAY_MINUTES,
    periodInMinutes: DAY_MINUTES,
  });
}

export interface MaintenanceDeps {
  vault: VaultService;
  storage: StorageAreaLike;
  tabs: TabsLike;
}

/** Deletes expired conversations and old log rows; tells tabs what went. */
export async function runCleanup({
  vault,
  storage,
  tabs,
}: MaintenanceDeps): Promise<CleanupResult> {
  const retentionDays = await readRetentionDays(storage);
  const result = await vault.deleteExpired({ retentionDays });
  devlog('vault.cleaned', { count: result.conversations.length });
  if (result.conversations.length > 0) {
    await notifyTabs(tabs, {
      name: 'vault.dropped',
      conversationIds: result.conversations,
    });
  }
  return result;
}

/**
 * Deletes everything: the database (mappings, conversations, log, custom
 * terms, keys) and chrome.storage.local except `onboardingDone`, then
 * creates new keys. Every tab is told to drop its mappings once the
 * database is gone, even if a later step fails.
 */
export async function deleteEverything({
  vault,
  storage,
  tabs,
}: MaintenanceDeps): Promise<KeyState> {
  const { onboardingDone } = await storage.get('onboardingDone');
  await vault.deleteDatabase();
  try {
    await storage.clear();
    if (typeof onboardingDone === 'boolean') {
      await storage.set({ onboardingDone });
    }
    const keys = await vault.ensureKeys();
    devlog('vault.deleted-all');
    return keys;
  } finally {
    await notifyTabs(tabs, { name: 'vault.dropped', conversationIds: 'all' });
  }
}
