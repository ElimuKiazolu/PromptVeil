/**
 * Vault keys: generated once (on install, or lazily on first use) and kept
 * in the `keys` store as non-extractable CryptoKeys.
 *
 * Keys are never created while encrypted records exist without them: new
 * keys would make the old records unreadable while the vault looked
 * healthy. That case is reported as `keys-lost` so the UI can say the
 * mappings were deleted.
 */
import { requestResult, withTransaction } from './db.ts';
import { STORE } from './schema.ts';
import {
  KEY_IDS,
  type KeyId,
  type KeyRecord,
  type VaultKeys,
} from './types.ts';

export type KeyState =
  | { status: 'ready'; keys: VaultKeys }
  | { status: 'keys-lost'; missing: readonly KeyId[] };

const ALGORITHM: Record<KeyId, string> = {
  enc: 'AES-GCM',
  lookup: 'HMAC',
  seed: 'HMAC',
};

const USAGES: Record<KeyId, readonly KeyUsage[]> = {
  enc: ['encrypt', 'decrypt'],
  lookup: ['sign'],
  seed: ['sign'],
};

function isUsableKey(id: KeyId, key: unknown): key is CryptoKey {
  if (typeof key !== 'object' || key === null) return false;
  if (!('algorithm' in key) || !('extractable' in key) || !('usages' in key)) {
    return false;
  }
  const { algorithm, extractable, usages } = key;
  return (
    extractable === false &&
    typeof algorithm === 'object' &&
    algorithm !== null &&
    'name' in algorithm &&
    algorithm.name === ALGORITHM[id] &&
    Array.isArray(usages) &&
    USAGES[id].every((usage) => usages.includes(usage))
  );
}

function usableKey(id: KeyId, record: unknown): CryptoKey | null {
  if (typeof record !== 'object' || record === null) return null;
  if (!('id' in record) || record.id !== id || !('key' in record)) return null;
  return isUsableKey(id, record.key) ? record.key : null;
}

interface Snapshot {
  keys: Partial<Record<KeyId, CryptoKey>>;
  encryptedRecords: number;
}

async function readSnapshot(transaction: IDBTransaction): Promise<Snapshot> {
  const keyStore = transaction.objectStore(STORE.keys);
  const keys: Partial<Record<KeyId, CryptoKey>> = {};
  for (const id of KEY_IDS) {
    const key = usableKey(id, await requestResult(keyStore.get(id)));
    if (key !== null) keys[id] = key;
  }
  const mappings = await requestResult(
    transaction.objectStore(STORE.mappings).count(),
  );
  const terms = await requestResult(
    transaction.objectStore(STORE.customTerms).count(),
  );
  return { keys, encryptedRecords: mappings + terms };
}

function complete(keys: Partial<Record<KeyId, CryptoKey>>): VaultKeys | null {
  const { enc, lookup, seed } = keys;
  return enc && lookup && seed ? { enc, lookup, seed } : null;
}

function stateOf(snapshot: Snapshot): KeyState | null {
  const keys = complete(snapshot.keys);
  if (keys !== null) return { status: 'ready', keys };
  if (snapshot.encryptedRecords > 0) {
    return {
      status: 'keys-lost',
      missing: KEY_IDS.filter((id) => snapshot.keys[id] === undefined),
    };
  }
  return null;
}

async function generateKeys(crypto: Crypto): Promise<VaultKeys> {
  const [enc, lookup, seed] = await Promise.all([
    crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
      'encrypt',
      'decrypt',
    ]),
    crypto.subtle.generateKey({ name: 'HMAC', hash: 'SHA-256' }, false, [
      'sign',
    ]),
    crypto.subtle.generateKey({ name: 'HMAC', hash: 'SHA-256' }, false, [
      'sign',
    ]),
  ]);
  return { enc, lookup, seed };
}

const KEY_SCOPE = [STORE.keys, STORE.mappings, STORE.customTerms] as const;

/**
 * Loads the keys, creating all three if none are usable and no encrypted
 * record exists. Concurrent callers end with one key set: creation re-checks
 * inside a read-write transaction, and such transactions run one at a time.
 */
export async function ensureKeys(
  db: IDBDatabase,
  crypto: Crypto,
  now: () => number,
): Promise<KeyState> {
  const existing = stateOf(
    await withTransaction(db, KEY_SCOPE, 'readonly', readSnapshot),
  );
  if (existing !== null) return existing;

  // Web Crypto cannot run inside a transaction (it would commit early), so
  // the candidate keys are generated first and written only if still needed.
  const candidate = await generateKeys(crypto);
  return withTransaction(db, KEY_SCOPE, 'readwrite', async (transaction) => {
    const current = stateOf(await readSnapshot(transaction));
    if (current !== null) return current;
    const store = transaction.objectStore(STORE.keys);
    // Unusable leftovers (a partial set) are replaced as one new set.
    await requestResult(store.clear());
    const createdAt = now();
    for (const id of KEY_IDS) {
      const record: KeyRecord = { id, key: candidate[id], createdAt };
      await requestResult(store.add(record));
    }
    return { status: 'ready', keys: candidate };
  });
}
