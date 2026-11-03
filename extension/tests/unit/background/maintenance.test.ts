import { IDBFactory } from 'fake-indexeddb';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CLEANUP_ALARM,
  deleteEverything,
  ensureCleanupAlarm,
  readRetentionDays,
  runCleanup,
  type AlarmsLike,
  type StorageAreaLike,
} from '@/src/background/maintenance.ts';
import { notifyTabs } from '@/src/background/tab-notices.ts';
import { DB_NAME, STORE } from '@/src/core/vault/schema.ts';
import {
  createVaultService,
  type VaultService,
} from '@/src/core/vault/service.ts';
import { listenForNotices } from '@/src/shared/messaging.ts';
import { DEFAULT_SETTINGS } from '@/src/shared/settings.ts';
import {
  isVaultNotice,
  type VaultNotice,
} from '@/src/shared/vault-protocol.ts';
import {
  dumpAll,
  openRaw,
  realValue,
  webCrypto,
} from '../core/vault/harness.ts';
import { FakeExtension } from '../extension-fakes.ts';

const DAY = 86_400_000;

/** chrome.storage.local in memory. */
class FakeStorage implements StorageAreaLike {
  readonly items = new Map<string, unknown>();
  failClear = false;

  get(keys: string | string[]): Promise<Record<string, unknown>> {
    const out: Record<string, unknown> = {};
    for (const key of typeof keys === 'string' ? [keys] : keys) {
      if (this.items.has(key)) out[key] = structuredClone(this.items.get(key));
    }
    return Promise.resolve(out);
  }

  set(items: Record<string, unknown>): Promise<void> {
    for (const [key, value] of Object.entries(items)) {
      this.items.set(key, structuredClone(value));
    }
    return Promise.resolve();
  }

  clear(): Promise<void> {
    if (this.failClear) return Promise.reject(new Error('storage failed'));
    this.items.clear();
    return Promise.resolve();
  }
}

const vaults: VaultService[] = [];

function setUp(now: () => number = () => 1_000 * DAY) {
  const ext = new FakeExtension();
  const factory = new IDBFactory();
  const vault = createVaultService({ idb: factory, crypto: webCrypto, now });
  vaults.push(vault);
  const storage = new FakeStorage();
  const tab = ext.openTab('https://chatgpt.com/');
  const notices: VaultNotice[] = [];
  listenForNotices(tab.runtime, isVaultNotice, (notice) => {
    notices.push(notice);
  });
  return {
    ext,
    factory,
    vault,
    storage,
    notices,
    deps: { vault, storage, tabs: ext.tabs },
  };
}

// Fixture identity address (example.com is reserved for documentation).
const DANA = realValue({
  type: 'EMAIL',
  subtype: null,
  country: null,
  value: 'dana.whitfield@example.com',
});

afterEach(() => {
  for (const vault of vaults.splice(0)) vault.close();
});

describe('retention setting', () => {
  it('reads the stored value and falls back to the default when it is missing or malformed', async () => {
    const storage = new FakeStorage();
    expect(await readRetentionDays(storage)).toBe(
      DEFAULT_SETTINGS.retentionDays,
    );
    for (const valid of [0, 1, 7, 365]) {
      await storage.set({ retentionDays: valid });
      expect(await readRetentionDays(storage)).toBe(valid);
    }
    for (const invalid of [-1, 1.5, '30', null, Number.NaN, 1e9]) {
      await storage.set({ retentionDays: invalid });
      expect(await readRetentionDays(storage)).toBe(
        DEFAULT_SETTINGS.retentionDays,
      );
    }
  });

  it('does not guess when storage cannot be read', async () => {
    const storage = new FakeStorage();
    storage.get = () => Promise.reject(new Error('storage failed'));
    await expect(readRetentionDays(storage)).rejects.toThrow('storage failed');
  });
});

describe('cleanup alarm', () => {
  it('is scheduled daily, once', async () => {
    const created: { name: string; period: number }[] = [];
    const alarms: AlarmsLike = {
      get: (name) =>
        Promise.resolve(created.find((alarm) => alarm.name === name)),
      create: (name, info) => {
        created.push({ name, period: info.periodInMinutes });
        return Promise.resolve();
      },
    };
    await ensureCleanupAlarm(alarms);
    await ensureCleanupAlarm(alarms);
    expect(created).toEqual([{ name: CLEANUP_ALARM, period: 24 * 60 }]);
  });
});

describe('auto-delete run', () => {
  it('uses the retention setting and tells tabs which conversations went', async () => {
    const clock = { now: 1_000 * DAY };
    const { vault, storage, notices, deps } = setUp(() => clock.now);
    await vault.maskValues({
      conversationId: 'chatgpt:old-conv',
      site: 'chatgpt',
      status: 'active',
      items: [DANA],
    });
    clock.now += 8 * DAY;
    await storage.set({ retentionDays: 7 });
    expect(await runCleanup(deps)).toMatchObject({
      conversations: ['chatgpt:old-conv'],
      mappings: 1,
    });
    expect(notices).toEqual([
      { name: 'vault.dropped', conversationIds: ['chatgpt:old-conv'] },
    ]);
    // Nothing expired: no notice.
    await runCleanup(deps);
    expect(notices).toHaveLength(1);
  });
});

describe('delete everything', () => {
  it('deletes the database and settings except onboardingDone, makes new keys and tells every tab', async () => {
    const { vault, storage, notices, factory, deps } = setUp();
    await vault.maskValues({
      conversationId: 'chatgpt:conv-1',
      site: 'chatgpt',
      status: 'active',
      items: [DANA],
    });
    await storage.set({
      onboardingDone: true,
      retentionDays: 7,
      homeRegions: ['GB'],
    });

    expect((await deleteEverything(deps)).status).toBe('ready');
    expect([...storage.items]).toEqual([['onboardingDone', true]]);
    expect(notices).toEqual([
      { name: 'vault.dropped', conversationIds: 'all' },
    ]);
    const db = await openRaw(factory, DB_NAME);
    const dump = await dumpAll(db);
    db.close();
    expect(dump.get(STORE.mappings)).toEqual([]);
    expect(dump.get(STORE.conversations)).toEqual([]);
    expect(dump.get(STORE.keys)).toHaveLength(3);
  });

  it('keeps no onboarding flag that was never set', async () => {
    const { storage, deps } = setUp();
    await storage.set({ retentionDays: 7 });
    await deleteEverything(deps);
    expect(storage.items.size).toBe(0);
  });

  it('still tells the tabs when a step after the deletion fails', async () => {
    const { storage, notices, deps } = setUp();
    storage.failClear = true;
    await expect(deleteEverything(deps)).rejects.toThrow('storage failed');
    expect(notices).toEqual([
      { name: 'vault.dropped', conversationIds: 'all' },
    ]);
  });
});

describe('tab notices', () => {
  it('skips the excepted tab and survives tabs that cannot receive', async () => {
    const ext = new FakeExtension();
    const listening = ext.openTab('https://chatgpt.com/');
    ext.openTab('https://chatgpt.com/c/abcdefgh');
    const received: VaultNotice[] = [];
    listenForNotices(listening.runtime, isVaultNotice, (notice) => {
      received.push(notice);
    });
    const notice: VaultNotice = {
      name: 'vault.changed',
      conversationId: 'chatgpt:abcdefgh',
    };
    await notifyTabs(ext.tabs, notice);
    await notifyTabs(ext.tabs, notice, listening.id);
    expect(received).toEqual([notice]);
    // A failing query is reported, not thrown.
    await notifyTabs(
      { ...ext.tabs, query: () => Promise.reject(new Error('no tabs')) },
      notice,
    );
  });
});
