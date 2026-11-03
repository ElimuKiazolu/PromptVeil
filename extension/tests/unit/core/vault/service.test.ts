import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import {
  decryptReal,
  encryptReal,
  type RecordBinding,
} from '@/src/core/vault/crypto.ts';
import { VaultError } from '@/src/core/vault/errors.ts';
import type { NewMapping } from '@/src/core/vault/mappings.ts';
import { DB_NAME, setSchemaVersion, STORE } from '@/src/core/vault/schema.ts';
import { createVaultService } from '@/src/core/vault/service.ts';
import {
  clearRaw,
  deleteRaw,
  dumpAll,
  forceClose,
  openRaw,
  openV1,
  RecordingFactory,
  testMigrations,
  webCrypto,
} from './harness.ts';

const CONV = 'chatgpt:conv-1';

// Fixture identity address (example.com is reserved for documentation).
const MAPPING: NewMapping = {
  conversationId: CONV,
  real: {
    type: 'EMAIL',
    subtype: null,
    country: null,
    value: 'dana.whitfield@example.com',
    normalised: 'dana.whitfield@example.com',
  },
  surrogate: 'standin.one@example.net',
  variants: [],
  locale: null,
  parentId: null,
  source: 'rule',
  confidence: 1,
};

function codeOf(error: unknown): string {
  return error instanceof VaultError ? error.code : 'not a VaultError';
}

describe('vault service', () => {
  it('opens the database and creates keys lazily on first use', async () => {
    const factory = new IDBFactory();
    const vault = createVaultService({ idb: factory, crypto: webCrypto });
    await vault.createConversation({
      id: CONV,
      site: 'chatgpt',
      status: 'active',
    });
    expect((await vault.insertMapping(MAPPING)).status).toBe('inserted');
    expect((await vault.ensureKeys()).status).toBe('ready');
    vault.close();
  });

  it('opens one connection per lifetime', async () => {
    const factory = new RecordingFactory();
    const vault = createVaultService({ idb: factory, crypto: webCrypto });
    await Promise.all([
      vault.ensureKeys(),
      vault.createConversation({ id: CONV, site: 'chatgpt', status: 'active' }),
      vault.isStandInTaken(CONV, 'x'),
    ]);
    expect(factory.connections).toHaveLength(1);
    vault.close();
  });

  it('keeps working across a worker restart (new service, same database)', async () => {
    const factory = new IDBFactory();
    const before = createVaultService({
      idb: factory,
      crypto: webCrypto,
      now: () => 1,
    });
    await before.createConversation({
      id: CONV,
      site: 'chatgpt',
      status: 'active',
    });
    await before.insertMapping(MAPPING);
    before.close();

    const after = createVaultService({
      idb: factory,
      crypto: webCrypto,
      now: () => 2,
    });
    const loaded = await after.loadConversation(CONV);
    expect(loaded.entries.map((entry) => entry.real)).toEqual([
      MAPPING.real.value,
    ]);
    expect((await after.findByReal(CONV, MAPPING.real))?.hitCount).toBe(1);
    after.close();
  });

  it('lets another context delete the database and starts afresh', async () => {
    const factory = new IDBFactory();
    const vault = createVaultService({ idb: factory, crypto: webCrypto });
    await vault.createConversation({
      id: CONV,
      site: 'chatgpt',
      status: 'active',
    });
    await vault.insertMapping(MAPPING);

    // Our connection closes on versionchange, so the deletion is not blocked.
    await deleteRaw(factory, DB_NAME);

    expect((await vault.ensureKeys()).status).toBe('ready');
    expect((await vault.loadConversation(CONV)).entries).toEqual([]);
    vault.close();
  });

  it('reopens after the browser closes the connection', async () => {
    const factory = new RecordingFactory();
    const vault = createVaultService({ idb: factory, crypto: webCrypto });
    await vault.createConversation({
      id: CONV,
      site: 'chatgpt',
      status: 'active',
    });
    const [first] = factory.connections;
    if (first === undefined) throw new Error('no connection');
    forceClose(first);
    expect(await vault.isStandInTaken(CONV, 'x')).toBe(false);
    expect(factory.connections).toHaveLength(2);
    vault.close();
  });

  it('retries opening after a failed open', async () => {
    class FailsOnce extends IDBFactory {
      private failed = false;

      override open(name: string, version?: number): IDBOpenDBRequest {
        if (!this.failed) {
          this.failed = true;
          throw new DOMException('denied', 'SecurityError');
        }
        return super.open(name, version);
      }
    }
    const vault = createVaultService({
      idb: new FailsOnce(),
      crypto: webCrypto,
    });
    await expect(vault.ensureKeys()).rejects.toSatisfy(
      (error: unknown) => codeOf(error) === 'unavailable',
    );
    expect((await vault.ensureKeys()).status).toBe('ready');
    vault.close();
  });

  it('fails every operation with keys-lost when keys vanished but mappings remain', async () => {
    const factory = new IDBFactory();
    const before = createVaultService({ idb: factory, crypto: webCrypto });
    await before.createConversation({
      id: CONV,
      site: 'chatgpt',
      status: 'active',
    });
    await before.insertMapping(MAPPING);
    before.close();
    const db = await openV1(factory);
    await clearRaw(db, STORE.keys);
    db.close();

    const after = createVaultService({ idb: factory, crypto: webCrypto });
    expect(await after.ensureKeys()).toEqual({
      status: 'keys-lost',
      missing: ['enc', 'lookup', 'seed'],
    });
    await expect(after.loadConversation(CONV)).rejects.toSatisfy(
      (error: unknown) => codeOf(error) === 'keys-lost',
    );
    await expect(after.insertMapping(MAPPING)).rejects.toSatisfy(
      (error: unknown) => codeOf(error) === 'keys-lost',
    );
    after.close();
    const check = await openRaw(factory, DB_NAME);
    expect((await dumpAll(check)).get(STORE.keys)).toEqual([]);
    check.close();
  });

  it('refuses a database newer than the code', async () => {
    const factory = new IDBFactory();
    const newer = createVaultService({
      idb: factory,
      crypto: webCrypto,
      migrations: testMigrations(({ transaction }) => {
        setSchemaVersion(transaction, 2);
      }),
    });
    await newer.ensureKeys();
    newer.close();
    const vault = createVaultService({ idb: factory, crypto: webCrypto });
    await expect(vault.ensureKeys()).rejects.toSatisfy(
      (error: unknown) => codeOf(error) === 'version-too-new',
    );
    vault.close();
  });
});

describe('vault service: delete everything', () => {
  it('deletes the database and creates new keys on the next use', async () => {
    const factory = new IDBFactory();
    const vault = createVaultService({ idb: factory, crypto: webCrypto });
    await vault.createConversation({
      id: CONV,
      site: 'chatgpt',
      status: 'active',
    });
    await vault.insertMapping(MAPPING);
    const before = await vault.ensureKeys();

    await vault.deleteDatabase();
    const after = await vault.ensureKeys();
    if (before.status !== 'ready' || after.status !== 'ready') {
      throw new Error('keys not ready');
    }
    // New key material: data sealed with the old key does not open.
    const binding: RecordBinding = {
      store: 'mappings',
      recordId: 'r',
      conversationId: CONV,
      type: 'EMAIL',
      subtype: null,
    };
    const sealed = await encryptReal(
      webCrypto,
      before.keys.enc,
      { value: 'probe', normalised: 'probe' },
      binding,
    );
    await expect(
      decryptReal(webCrypto, after.keys.enc, sealed, binding),
    ).rejects.toSatisfy((error: unknown) => codeOf(error) === 'decrypt-failed');
    expect((await vault.loadConversation(CONV)).entries).toEqual([]);
    const db = await openRaw(factory, DB_NAME);
    const dump = await dumpAll(db);
    db.close();
    expect(dump.get(STORE.mappings)).toEqual([]);
    expect(dump.get(STORE.conversations)).toEqual([]);
    expect(dump.get(STORE.keys)).toHaveLength(3);
    vault.close();
  });

  it('fails with blocked when another connection does not close', async () => {
    const factory = new IDBFactory();
    const vault = createVaultService({
      idb: factory,
      crypto: webCrypto,
      blockedTimeoutMs: 20,
    });
    await vault.ensureKeys();
    // A connection that ignores versionchange, unlike the vault's own.
    const stubborn = await openRaw(factory, DB_NAME);
    await expect(vault.deleteDatabase()).rejects.toSatisfy(
      (error: unknown) => codeOf(error) === 'blocked',
    );
    stubborn.close();
    vault.close();
  });
});
