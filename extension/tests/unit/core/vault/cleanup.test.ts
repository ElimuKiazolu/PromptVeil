import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import { deleteExpired, LOG_RETENTION_DAYS } from '@/src/core/vault/cleanup.ts';
import type { VaultContext } from '@/src/core/vault/mappings.ts';
import { STORE } from '@/src/core/vault/schema.ts';
import { createVaultService } from '@/src/core/vault/service.ts';
import {
  clearRaw,
  dumpAll,
  getRaw,
  maskValues,
  openV1,
  putRaw,
  readyContext,
  realValue,
  webCrypto,
} from './harness.ts';

const DAY = 86_400_000;
const NOW = 400 * DAY;

// Fixture identity address (example.com is reserved for documentation).
const DANA = realValue({
  type: 'EMAIL',
  subtype: null,
  country: null,
  value: 'dana.whitfield@example.com',
});

/** Masks a value into `id` with the clock set to `at`. */
async function touchAt(
  clock: { now: number },
  context: VaultContext,
  id: string,
  at: number,
): Promise<void> {
  clock.now = at;
  await maskValues(context, {
    conversationId: id,
    site: 'chatgpt',
    status: 'active',
    items: [DANA],
  });
}

async function setUp() {
  const clock = { now: 0 };
  const context = await readyContext(new IDBFactory(), () => clock.now);
  await touchAt(clock, context, 'chatgpt:old-conv', NOW - 31 * DAY);
  await touchAt(clock, context, 'chatgpt:edge-conv', NOW - 30 * DAY);
  await touchAt(clock, context, 'chatgpt:new-conv', NOW - DAY);
  for (const [id, age] of [
    [1, LOG_RETENTION_DAYS + 1],
    [2, LOG_RETENTION_DAYS],
    [3, 1],
  ] as const) {
    await putRaw(context.db, STORE.log, {
      id,
      timestamp: NOW - age * DAY,
      site: 'chatgpt',
      conversationId: 'chatgpt:new-conv',
    });
  }
  return context;
}

function ids(rows: unknown[] | undefined): unknown[] {
  return (rows ?? []).map((row) => (row as { id: unknown }).id).sort();
}

describe('auto-delete', () => {
  it('deletes conversations unused for longer than the retention, with their mappings', async () => {
    const context = await setUp();
    const result = await deleteExpired(context.db, NOW, { retentionDays: 30 });
    expect(result).toEqual({
      conversations: ['chatgpt:old-conv'],
      mappings: 1,
      logRows: 1,
    });
    const dump = await dumpAll(context.db);
    expect(ids(dump.get(STORE.conversations))).toEqual([
      'chatgpt:edge-conv',
      'chatgpt:new-conv',
    ]);
    expect(
      (dump.get(STORE.mappings) ?? []).map(
        (row) => (row as { conversationId: string }).conversationId,
      ),
    ).not.toContain('chatgpt:old-conv');
    expect(dump.get(STORE.mappings)).toHaveLength(2);
    expect(ids(dump.get(STORE.log))).toEqual([2, 3]);
    expect(await getRaw(context.db, STORE.meta, 'lastCleanupAt')).toEqual({
      key: 'lastCleanupAt',
      value: NOW,
    });
  });

  it('keeps every conversation when retention is 0, but still prunes the log', async () => {
    const context = await setUp();
    const result = await deleteExpired(context.db, NOW, { retentionDays: 0 });
    expect(result).toEqual({ conversations: [], mappings: 0, logRows: 1 });
    expect((await dumpAll(context.db)).get(STORE.conversations)).toHaveLength(
      3,
    );
  });

  it('runs through the service even when the keys are lost', async () => {
    const factory = new IDBFactory();
    const clock = { now: 0 };
    const context = await readyContext(factory, () => clock.now);
    await touchAt(clock, context, 'chatgpt:old-conv', NOW - 400 * DAY + 1);
    context.db.close();
    const raw = await openV1(factory);
    await clearRaw(raw, STORE.keys);
    raw.close();

    const vault = createVaultService({
      idb: factory,
      crypto: webCrypto,
      now: () => NOW,
    });
    expect((await vault.ensureKeys()).status).toBe('keys-lost');
    expect(await vault.deleteExpired({ retentionDays: 30 })).toMatchObject({
      conversations: ['chatgpt:old-conv'],
      mappings: 1,
    });
    // With no encrypted records left, fresh keys can be created.
    expect((await vault.ensureKeys()).status).toBe('ready');
    vault.close();
  });
});
