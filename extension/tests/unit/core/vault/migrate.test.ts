import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import { maskValues } from '@/src/core/vault/mask.ts';
import {
  findByReal,
  loadConversation,
  type VaultContext,
} from '@/src/core/vault/mappings.ts';
import {
  commitMigration,
  MAX_MIGRATION_ATTEMPTS,
  migrateConversation,
  prepareMigration,
} from '@/src/core/vault/migrate.ts';
import { STORE } from '@/src/core/vault/schema.ts';
import {
  codeOf,
  dumpAll,
  getRaw,
  openV1,
  putRaw,
  readyContext,
  realValue,
} from './harness.ts';

const PENDING = 'chatgpt:pending:6f1c2a4e-8b3d-4c5e-9f7a-1b2c3d4e5f60';
const TARGET = 'chatgpt:6800a1b2-c3d4-4e5f-8a9b-0c1d2e3f4a5b';

// Fixture identity addresses (example.com and example.org are reserved).
const DANA = realValue({
  type: 'EMAIL',
  subtype: null,
  country: null,
  value: 'dana.whitfield@example.com',
});
const ROBIN = realValue({
  type: 'EMAIL',
  subtype: null,
  country: null,
  value: 'robin.hale@example.org',
});
const SAM = realValue({
  type: 'EMAIL',
  subtype: null,
  country: null,
  value: 'sam.okafor@example.net',
});

async function maskInto(
  context: VaultContext,
  conversationId: string,
  items = [DANA, ROBIN],
): Promise<string[]> {
  const result = await maskValues(context, {
    conversationId,
    site: 'chatgpt',
    status: conversationId === PENDING ? 'pending' : 'active',
    items,
  });
  return result.standIns;
}

async function conversation(context: VaultContext, id: string) {
  return getRaw(context.db, STORE.conversations, id);
}

describe('pending chat migration', () => {
  it('moves every mapping to the new conversation, re-encrypted and re-hashed', async () => {
    let clock = 5_000;
    const context = await readyContext(new IDBFactory(), () => (clock += 1));
    const standIns = await maskInto(context, PENDING);
    const pending = await conversation(context, PENDING);

    const outcome = await migrateConversation(context, PENDING, TARGET);
    expect(outcome).toEqual({ status: 'migrated', count: 2, dropped: 0 });

    const loaded = await loadConversation(context, TARGET);
    expect(loaded.failed).toBe(0);
    expect(
      loaded.entries.map((entry) => [entry.surrogate, entry.real]).sort(),
    ).toEqual(
      [
        [standIns[0], DANA.value],
        [standIns[1], ROBIN.value],
      ].sort(),
    );
    // Found by the new conversation's hash; the old conversation is gone.
    expect((await findByReal(context, TARGET, DANA))?.surrogate).toBe(
      standIns[0],
    );
    expect(await conversation(context, PENDING)).toBeUndefined();
    expect(await loadConversation(context, PENDING)).toEqual({
      entries: [],
      failed: 0,
    });
    // The pending chat's date offset and creation time carry over.
    expect(await conversation(context, TARGET)).toMatchObject({
      id: TARGET,
      status: 'active',
      mappingCount: 2,
      dateOffsetDays: (pending as { dateOffsetDays: number }).dateOffsetDays,
      createdAt: (pending as { createdAt: number }).createdAt,
    });
    // The next send in the new conversation reuses the moved stand-ins.
    expect(await maskInto(context, TARGET, [ROBIN])).toEqual([standIns[1]]);
  });

  it('points the pending chat log rows at the new conversation', async () => {
    const context = await readyContext();
    await maskInto(context, PENDING);
    await putRaw(context.db, STORE.log, {
      id: 1,
      timestamp: 1,
      conversationId: PENDING,
    });
    await putRaw(context.db, STORE.log, {
      id: 2,
      timestamp: 2,
      conversationId: 'chatgpt:other-conv',
    });
    await migrateConversation(context, PENDING, TARGET);
    expect((await dumpAll(context.db)).get(STORE.log)).toEqual([
      { id: 1, timestamp: 1, conversationId: TARGET },
      { id: 2, timestamp: 2, conversationId: 'chatgpt:other-conv' },
    ]);
  });

  it('reports nothing to move when the pending chat is not stored', async () => {
    const context = await readyContext();
    expect(await migrateConversation(context, PENDING, TARGET)).toEqual({
      status: 'nothing',
    });
    await maskInto(context, PENDING);
    await migrateConversation(context, PENDING, TARGET);
    // A second tab or a retry finds it already moved.
    expect(await migrateConversation(context, PENDING, TARGET)).toEqual({
      status: 'nothing',
    });
  });

  it('merges into a target conversation that already exists', async () => {
    const context = await readyContext();
    await maskInto(context, PENDING);
    const [samStandIn] = await maskInto(context, TARGET, [SAM]);
    expect(await migrateConversation(context, PENDING, TARGET)).toMatchObject({
      count: 2,
    });
    expect(await conversation(context, TARGET)).toMatchObject({
      mappingCount: 3,
    });
    const loaded = await loadConversation(context, TARGET);
    expect(loaded.entries).toHaveLength(3);
    expect(await maskInto(context, TARGET, [SAM])).toEqual([samStandIn]);
  });

  it('writes nothing and reports a change made between the two steps', async () => {
    const factory = new IDBFactory();
    const context = await readyContext(factory);
    await maskInto(context, PENDING, [DANA]);
    const plan = await prepareMigration(context, PENDING, TARGET);
    if (plan === null) throw new Error('no plan');

    // Another value is masked into the pending chat meanwhile.
    await maskInto(context, PENDING, [ROBIN]);
    const before = await dumpAll(context.db);
    expect(await commitMigration(context, plan)).toEqual({
      status: 'changed',
    });
    expect(await dumpAll(context.db)).toEqual(before);

    // Preparing again includes the new mapping.
    expect(await migrateConversation(context, PENDING, TARGET)).toMatchObject({
      status: 'migrated',
      count: 2,
    });
  });

  it('detects a mapping removed between the two steps', async () => {
    const context = await readyContext();
    await maskInto(context, PENDING);
    const plan = await prepareMigration(context, PENDING, TARGET);
    if (plan === null) throw new Error('no plan');
    const [first] = (await dumpAll(context.db)).get(STORE.mappings) ?? [];
    const db = context.db;
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(STORE.mappings, 'readwrite');
      transaction
        .objectStore(STORE.mappings)
        .delete((first as { id: string }).id);
      transaction.oncomplete = () => {
        resolve();
      };
      transaction.onabort = () => {
        reject(new Error('delete aborted'));
      };
    });
    expect(await commitMigration(context, plan)).toEqual({
      status: 'changed',
    });
  });

  it('rolls everything back when a moved mapping conflicts with the target', async () => {
    const context = await readyContext();
    await maskInto(context, PENDING, [DANA, ROBIN, SAM]);
    // The target already uses the stand-in of the record written last, so
    // the conversation and the other mappings are written before the
    // conflict aborts the transaction.
    const records = ((await dumpAll(context.db)).get(STORE.mappings) ?? []) as {
      id: string;
      surrogate: string;
    }[];
    const last = [...records].sort((a, b) => a.id.localeCompare(b.id)).at(-1);
    if (last === undefined) throw new Error('no records');
    await maskValues(
      context,
      {
        conversationId: TARGET,
        site: 'chatgpt',
        status: 'active',
        items: [
          realValue({
            type: 'EMAIL',
            subtype: null,
            country: null,
            value: 'ops@example.com',
          }),
        ],
      },
      () => last.surrogate,
    );
    const before = await dumpAll(context.db);

    await expect(
      migrateConversation(context, PENDING, TARGET),
    ).rejects.toSatisfy((error: unknown) => codeOf(error) === 'constraint');
    expect(await dumpAll(context.db)).toEqual(before);
    expect((await loadConversation(context, PENDING)).entries).toHaveLength(3);
  });

  it('drops records that cannot be decrypted', async () => {
    const context = await readyContext();
    await maskInto(context, PENDING);
    const [record] = (await dumpAll(context.db)).get(STORE.mappings) ?? [];
    await putRaw(context.db, STORE.mappings, {
      ...(record as object),
      id: 'tampered',
      realHash: 'other-hash',
      surrogateNorm: 'other-standin',
    });
    await putRaw(context.db, STORE.mappings, {
      id: 'malformed',
      conversationId: PENDING,
    });
    expect(await migrateConversation(context, PENDING, TARGET)).toEqual({
      status: 'migrated',
      count: 2,
      dropped: 2,
    });
    const ids = ((await dumpAll(context.db)).get(STORE.mappings) ?? []).map(
      (row) => (row as { id: string }).id,
    );
    expect(ids).not.toContain('tampered');
    expect(ids).not.toContain('malformed');
    expect(await loadConversation(context, TARGET)).toMatchObject({
      failed: 0,
    });
  });

  it(`fails after ${MAX_MIGRATION_ATTEMPTS.toString()} rounds that each find a change`, async () => {
    const factory = new IDBFactory();
    const base = await readyContext(factory);
    await maskInto(base, PENDING, [DANA]);
    // Another context adds a record during every preparation.
    const other = await openV1(factory);
    let added = 0;
    const encrypt: SubtleCrypto['encrypt'] = async (...args) => {
      const ct = await base.crypto.subtle.encrypt(...args);
      added += 1;
      await putRaw(other, STORE.mappings, {
        id: `late-${added.toString()}`,
        conversationId: PENDING,
      });
      return ct;
    };
    // Web Crypto methods need their own receiver, hence the binding.
    const forward = <T extends object>(target: T, own: Partial<T>): T =>
      new Proxy(target, {
        get(object, property) {
          if (Object.hasOwn(own, property)) {
            return Reflect.get(own, property) as unknown;
          }
          const value: unknown = Reflect.get(object, property);
          if (typeof value !== 'function') return value;
          return (...args: unknown[]): unknown =>
            Reflect.apply(value, object, args) as unknown;
        },
      });
    const crypto = forward(base.crypto, {
      subtle: forward(base.crypto.subtle, { encrypt }),
    });

    await expect(
      migrateConversation({ ...base, crypto }, PENDING, TARGET),
    ).rejects.toSatisfy((error: unknown) => codeOf(error) === 'aborted');
    expect(added).toBe(MAX_MIGRATION_ATTEMPTS);
    expect(await conversation(base, PENDING)).toBeDefined();
    other.close();
  });
});
