import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import {
  decryptValue,
  encryptValue,
  type RecordBinding,
} from '@/src/core/vault/crypto.ts';
import { ensureKeys, type KeyState } from '@/src/core/vault/keys.ts';
import { STORE } from '@/src/core/vault/schema.ts';
import type { VaultKeys } from '@/src/core/vault/types.ts';
import {
  clearRaw,
  dumpAll,
  getRaw,
  openV1,
  putRaw,
  webCrypto,
} from './harness.ts';

const now = (): number => 7_000;

function ready(state: KeyState): VaultKeys {
  if (state.status !== 'ready') throw new Error(`keys ${state.status}`);
  return state.keys;
}

const BINDING: RecordBinding = {
  store: 'mappings',
  recordId: 'r',
  conversationId: 'chatgpt:c',
  type: 'EMAIL',
  subtype: null,
};

/** True when data encrypted with `a` decrypts with `b` (same key material). */
async function sameEncKey(a: VaultKeys, b: VaultKeys): Promise<boolean> {
  const encrypted = await encryptValue(webCrypto, a.enc, 'probe', BINDING);
  return decryptValue(webCrypto, b.enc, encrypted, BINDING).then(
    () => true,
    () => false,
  );
}

/** A stored record standing in for real encrypted data. */
const STORED_MAPPING = {
  id: 'm1',
  conversationId: 'chatgpt:c',
  realHash: 'h',
  surrogateNorm: 's',
};

describe('ensureKeys', () => {
  it('creates three non-extractable keys of the right kinds', async () => {
    const db = await openV1(new IDBFactory());
    const keys = ready(await ensureKeys(db, webCrypto, now));
    expect(keys.enc.algorithm).toMatchObject({ name: 'AES-GCM', length: 256 });
    expect(keys.lookup.algorithm).toMatchObject({
      name: 'HMAC',
      hash: { name: 'SHA-256' },
    });
    expect(keys.seed.algorithm).toMatchObject({
      name: 'HMAC',
      hash: { name: 'SHA-256' },
    });
    for (const key of [keys.enc, keys.lookup, keys.seed]) {
      expect(key.extractable).toBe(false);
    }
    expect([...keys.enc.usages].sort()).toEqual(['decrypt', 'encrypt']);
    expect(keys.lookup.usages).toEqual(['sign']);
    expect(await getRaw(db, STORE.keys, 'enc')).toMatchObject({
      id: 'enc',
      createdAt: 7_000,
    });
    db.close();
  });

  it('loads the same keys on the next start (structured clone)', async () => {
    const factory = new IDBFactory();
    const first = await openV1(factory);
    const created = ready(await ensureKeys(first, webCrypto, now));
    first.close();
    const second = await openV1(factory);
    const loaded = ready(await ensureKeys(second, webCrypto, () => 9_000));
    expect(await sameEncKey(created, loaded)).toBe(true);
    expect(await getRaw(second, STORE.keys, 'lookup')).toMatchObject({
      createdAt: 7_000,
    });
    second.close();
  });

  it('ends with one key set when several callers start at once', async () => {
    const db = await openV1(new IDBFactory());
    const states = await Promise.all(
      Array.from({ length: 5 }, () => ensureKeys(db, webCrypto, now)),
    );
    const sets = states.map(ready);
    expect((await dumpAll(db)).get(STORE.keys)).toHaveLength(3);
    for (const keys of sets) {
      expect(await sameEncKey(sets[0] ?? keys, keys)).toBe(true);
    }
    db.close();
  });

  it('reports keys-lost and creates nothing when mappings exist without keys', async () => {
    const db = await openV1(new IDBFactory());
    await putRaw(db, STORE.mappings, STORED_MAPPING);
    const state = await ensureKeys(db, webCrypto, now);
    expect(state).toEqual({
      status: 'keys-lost',
      missing: ['enc', 'lookup', 'seed'],
    });
    expect((await dumpAll(db)).get(STORE.keys)).toEqual([]);
    // Still lost on the next call: no silent regeneration.
    expect((await ensureKeys(db, webCrypto, now)).status).toBe('keys-lost');
    db.close();
  });

  it('reports keys-lost when custom terms exist without keys', async () => {
    const db = await openV1(new IDBFactory());
    await putRaw(db, STORE.customTerms, {
      id: 't1',
      list: 'always_mask',
      termHash: 'h',
    });
    expect((await ensureKeys(db, webCrypto, now)).status).toBe('keys-lost');
    db.close();
  });

  it('reports which keys are missing from a partial set while data exists', async () => {
    const db = await openV1(new IDBFactory());
    ready(await ensureKeys(db, webCrypto, now));
    await putRaw(db, STORE.mappings, STORED_MAPPING);
    const records = (await dumpAll(db)).get(STORE.keys) ?? [];
    await clearRaw(db, STORE.keys);
    for (const record of records) {
      if (
        typeof record === 'object' &&
        record !== null &&
        'id' in record &&
        record.id !== 'lookup'
      ) {
        await putRaw(db, STORE.keys, record);
      }
    }
    expect(await ensureKeys(db, webCrypto, now)).toEqual({
      status: 'keys-lost',
      missing: ['lookup'],
    });
    db.close();
  });

  it('replaces a partial or unusable key set as a whole when no data exists', async () => {
    const db = await openV1(new IDBFactory());
    const extractable = await webCrypto.subtle.generateKey(
      { name: 'AES-GCM', length: 256 },
      true,
      ['encrypt', 'decrypt'],
    );
    await putRaw(db, STORE.keys, { id: 'enc', key: extractable, createdAt: 1 });
    await putRaw(db, STORE.keys, {
      id: 'lookup',
      key: 'not a key',
      createdAt: 1,
    });
    const keys = ready(await ensureKeys(db, webCrypto, now));
    expect(keys.enc.extractable).toBe(false);
    const stored = (await dumpAll(db)).get(STORE.keys) ?? [];
    expect(stored).toHaveLength(3);
    for (const record of stored)
      expect(record).toMatchObject({ createdAt: 7_000 });
    db.close();
  });

  it('treats keys of the wrong algorithm as missing', async () => {
    const db = await openV1(new IDBFactory());
    const keys = ready(await ensureKeys(db, webCrypto, now));
    // An HMAC key stored as `enc` is unusable for AES-GCM.
    await putRaw(db, STORE.keys, { id: 'enc', key: keys.lookup, createdAt: 1 });
    await putRaw(db, STORE.mappings, STORED_MAPPING);
    expect(await ensureKeys(db, webCrypto, now)).toEqual({
      status: 'keys-lost',
      missing: ['enc'],
    });
    db.close();
  });
});
