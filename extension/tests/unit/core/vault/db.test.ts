import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it, vi } from 'vitest';
import {
  openVaultDb,
  requestResult,
  withTransaction,
} from '@/src/core/vault/db.ts';
import { VaultError } from '@/src/core/vault/errors.ts';
import {
  DB_NAME,
  setSchemaVersion,
  STORE,
  type Migration,
} from '@/src/core/vault/schema.ts';
import {
  forceClose,
  getRaw,
  openV1,
  putRaw,
  testMigrations,
} from './harness.ts';

function codeOf(error: unknown): string {
  return error instanceof VaultError ? error.code : 'not a VaultError';
}

/** Test-only version 2: an index on conversation status. */
const addStatusIndex: Migration = ({ transaction }) => {
  transaction
    .objectStore(STORE.conversations)
    .createIndex('by_status', 'status');
  setSchemaVersion(transaction, 2);
};

interface IndexShape {
  name: string;
  keyPath: string | string[];
  unique: boolean;
}

function describeStore(db: IDBDatabase, name: string) {
  const store = db.transaction(name).objectStore(name);
  const indexes: IndexShape[] = [...store.indexNames].map((indexName) => {
    const index = store.index(indexName);
    return { name: indexName, keyPath: index.keyPath, unique: index.unique };
  });
  return {
    keyPath: store.keyPath,
    autoIncrement: store.autoIncrement,
    indexes,
  };
}

describe('schema version 1', () => {
  it('creates every store and index of the schema on an empty database', async () => {
    const db = await openV1(new IDBFactory(), 1_234);
    expect(db.name).toBe(DB_NAME);
    expect(db.version).toBe(1);
    expect([...db.objectStoreNames].sort()).toEqual(
      [
        'conversations',
        'customTerms',
        'keys',
        'log',
        'mappings',
        'meta',
      ].sort(),
    );
    expect(describeStore(db, 'keys')).toEqual({
      keyPath: 'id',
      autoIncrement: false,
      indexes: [],
    });
    expect(describeStore(db, 'conversations')).toEqual({
      keyPath: 'id',
      autoIncrement: false,
      indexes: [
        { name: 'by_lastUsedAt', keyPath: 'lastUsedAt', unique: false },
        { name: 'by_site', keyPath: 'site', unique: false },
      ],
    });
    expect(describeStore(db, 'mappings')).toEqual({
      keyPath: 'id',
      autoIncrement: false,
      indexes: [
        {
          name: 'by_conv_realHash',
          keyPath: ['conversationId', 'realHash'],
          unique: true,
        },
        {
          name: 'by_conv_surrogate',
          keyPath: ['conversationId', 'surrogateNorm'],
          unique: true,
        },
        { name: 'by_conversation', keyPath: 'conversationId', unique: false },
      ],
    });
    expect(describeStore(db, 'log')).toEqual({
      keyPath: 'id',
      autoIncrement: true,
      indexes: [
        { name: 'by_site', keyPath: 'site', unique: false },
        { name: 'by_timestamp', keyPath: 'timestamp', unique: false },
      ],
    });
    expect(describeStore(db, 'customTerms')).toEqual({
      keyPath: 'id',
      autoIncrement: false,
      indexes: [
        { name: 'by_list', keyPath: 'list', unique: false },
        { name: 'by_termHash', keyPath: 'termHash', unique: true },
      ],
    });
    expect(describeStore(db, 'meta')).toEqual({
      keyPath: 'key',
      autoIncrement: false,
      indexes: [],
    });
    expect(await getRaw(db, 'meta', 'schemaVersion')).toEqual({
      key: 'schemaVersion',
      value: 1,
    });
    expect(await getRaw(db, 'meta', 'installedAt')).toEqual({
      key: 'installedAt',
      value: 1_234,
    });
    db.close();
  });

  it('opens an existing version 1 database without migrating again', async () => {
    const factory = new IDBFactory();
    const first = await openV1(factory, 1_000);
    first.close();
    const second = await openV1(factory, 2_000);
    expect(await getRaw(second, 'meta', 'installedAt')).toEqual({
      key: 'installedAt',
      value: 1_000,
    });
    second.close();
  });
});

describe('upgrades', () => {
  const conversation = {
    id: 'chatgpt:conv-1',
    site: 'chatgpt',
    status: 'active',
    dateOffsetDays: 42,
    createdAt: 1,
    lastUsedAt: 1,
    mappingCount: 0,
  };

  it('upgrades version 1 to a test version 2 and keeps the data', async () => {
    const factory = new IDBFactory();
    const v1 = await openV1(factory);
    await putRaw(v1, STORE.conversations, conversation);
    v1.close();

    const v2 = await openVaultDb({
      idb: factory,
      now: () => 5,
      migrations: testMigrations(addStatusIndex),
    });
    expect(v2.version).toBe(2);
    expect(await getRaw(v2, STORE.conversations, conversation.id)).toEqual(
      conversation,
    );
    expect(await getRaw(v2, 'meta', 'schemaVersion')).toEqual({
      key: 'schemaVersion',
      value: 2,
    });
    const store = v2
      .transaction(STORE.conversations)
      .objectStore(STORE.conversations);
    expect([...store.indexNames]).toContain('by_status');
    v2.close();
  });

  it('runs every step from an empty database to version 2', async () => {
    const db = await openVaultDb({
      idb: new IDBFactory(),
      now: () => 5,
      migrations: testMigrations(addStatusIndex),
    });
    expect([...db.objectStoreNames]).toHaveLength(6);
    expect(await getRaw(db, 'meta', 'schemaVersion')).toEqual({
      key: 'schemaVersion',
      value: 2,
    });
    db.close();
  });

  it('rolls back a failed step: the database stays at version 1 with its data', async () => {
    const factory = new IDBFactory();
    const v1 = await openV1(factory);
    await putRaw(v1, STORE.conversations, conversation);
    v1.close();

    const failing: Migration = ({ transaction }) => {
      transaction.objectStore(STORE.conversations).clear();
      throw new Error('step failed');
    };
    await expect(
      openVaultDb({
        idb: factory,
        now: () => 5,
        migrations: testMigrations(failing),
      }),
    ).rejects.toSatisfy((error: unknown) => codeOf(error) === 'upgrade-failed');

    const again = await openV1(factory);
    expect(again.version).toBe(1);
    expect(await getRaw(again, STORE.conversations, conversation.id)).toEqual(
      conversation,
    );
    again.close();
  });

  it('refuses a database newer than the code', async () => {
    const factory = new IDBFactory();
    const v2 = await openVaultDb({
      idb: factory,
      now: () => 5,
      migrations: testMigrations(addStatusIndex),
    });
    v2.close();
    await expect(openV1(factory)).rejects.toSatisfy(
      (error: unknown) => codeOf(error) === 'version-too-new',
    );
  });

  it('reports a factory that cannot open as unavailable', async () => {
    class Unavailable extends IDBFactory {
      override open(): IDBOpenDBRequest {
        throw new DOMException('denied', 'SecurityError');
      }
    }
    await expect(openV1(new Unavailable())).rejects.toSatisfy(
      (error: unknown) => codeOf(error) === 'unavailable',
    );
  });
});

describe('other contexts', () => {
  it('closes its own connection when another context needs a new version', async () => {
    const factory = new IDBFactory();
    const onVersionChange = vi.fn();
    const v1 = await openVaultDb({
      idb: factory,
      now: () => 1,
      onVersionChange,
    });
    const v2 = await openVaultDb({
      idb: factory,
      now: () => 2,
      migrations: testMigrations(addStatusIndex),
      blockedTimeoutMs: 1_000,
    });
    expect(onVersionChange).toHaveBeenCalledTimes(1);
    expect(v2.version).toBe(2);
    // The old connection is closed: using it throws.
    expect(() => v1.transaction(STORE.meta)).toThrow();
    v2.close();
  });

  it('fails with blocked when an old connection stays open, and closes the late connection', async () => {
    const factory = new IDBFactory();
    // A version 1 context that ignores versionchange (no handler closing it).
    const stale = await openV1(factory);
    stale.onversionchange = null;
    const opening = openVaultDb({
      idb: factory,
      now: () => 2,
      migrations: testMigrations(addStatusIndex),
      blockedTimeoutMs: 20,
    });
    await expect(opening).rejects.toSatisfy(
      (error: unknown) => codeOf(error) === 'blocked',
    );
    // Once the stale context closes, the pending upgrade completes; that late
    // connection must be closed at once, so a later upgrade is not blocked.
    stale.close();
    const addV3: Migration = ({ transaction }) => {
      setSchemaVersion(transaction, 3);
    };
    const v3 = await openVaultDb({
      idb: factory,
      now: () => 3,
      migrations: testMigrations(addStatusIndex, addV3),
      blockedTimeoutMs: 200,
    });
    expect(v3.version).toBe(3);
    v3.close();
  });

  it('reports a forced close', async () => {
    const onClose = vi.fn();
    const db = await openVaultDb({
      idb: new IDBFactory(),
      now: () => 1,
      onClose,
    });
    forceClose(db);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('withTransaction', () => {
  it('keeps nothing a failing body wrote and rethrows its error', async () => {
    const db = await openV1(new IDBFactory());
    const failure = new VaultError('corrupt-record');
    await expect(
      withTransaction(db, [STORE.meta], 'readwrite', async (transaction) => {
        await requestResult(
          transaction.objectStore(STORE.meta).put({ key: 'probe', value: 1 }),
        );
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(await getRaw(db, STORE.meta, 'probe')).toBeUndefined();
    db.close();
  });

  it('maps a unique-index violation to constraint', async () => {
    const db = await openV1(new IDBFactory());
    await expect(
      withTransaction(db, [STORE.meta], 'readwrite', async (transaction) => {
        const store = transaction.objectStore(STORE.meta);
        await requestResult(store.add({ key: 'twice', value: 1 }));
        await requestResult(store.add({ key: 'twice', value: 2 }));
      }),
    ).rejects.toSatisfy((error: unknown) => codeOf(error) === 'constraint');
    expect(await getRaw(db, STORE.meta, 'twice')).toBeUndefined();
    db.close();
  });

  it('reports a closed connection', async () => {
    const db = await openV1(new IDBFactory());
    db.close();
    await expect(
      withTransaction(db, [STORE.meta], 'readonly', () => Promise.resolve(1)),
    ).rejects.toSatisfy((error: unknown) => codeOf(error) === 'closed');
  });

  it('maps other platform errors by name and keeps a fallback', async () => {
    const { toVaultError } = await import('@/src/core/vault/errors.ts');
    expect(
      toVaultError(new DOMException('x', 'QuotaExceededError'), 'aborted').code,
    ).toBe('quota');
    expect(
      toVaultError(new DOMException('x', 'AbortError'), 'closed').code,
    ).toBe('aborted');
    expect(toVaultError('odd', 'unavailable').code).toBe('unavailable');
    const original = new VaultError('keys-lost');
    expect(toVaultError(original, 'aborted')).toBe(original);
  });
});
