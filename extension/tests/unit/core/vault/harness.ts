/**
 * Vault test helpers: an isolated in-memory IndexedDB per test
 * (fake-indexeddb) and Node's Web Crypto.
 */
import { Buffer } from 'node:buffer';
import { forceCloseDatabase, IDBFactory } from 'fake-indexeddb';
import { normaliseReal } from '@/src/core/detect/normal-form.ts';
import { openVaultDb } from '@/src/core/vault/db.ts';
import { VaultError } from '@/src/core/vault/errors.ts';
import { ensureKeys } from '@/src/core/vault/keys.ts';
import type { RealValue, VaultContext } from '@/src/core/vault/mappings.ts';
import { MIGRATIONS, type Migration } from '@/src/core/vault/schema.ts';

export const webCrypto: Crypto = globalThis.crypto;

/** An IDBFactory that also records every connection it opens. */
export class RecordingFactory extends IDBFactory {
  readonly connections: IDBDatabase[] = [];

  override open(name: string, version?: number): IDBOpenDBRequest {
    const request = super.open(name, version);
    request.addEventListener('success', () => {
      this.connections.push(request.result);
    });
    return request;
  }
}

/** Simulates the browser closing a connection (e.g. site data cleared in DevTools). */
export function forceClose(db: IDBDatabase): void {
  // fake-indexeddb declares the parameter as the IDBDatabase constructor type,
  // but the function takes a connection (see its documentation).
  forceCloseDatabase(db as unknown as typeof IDBDatabase);
}

export function openRaw(
  factory: IDBFactory,
  name: string,
  version?: number,
): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(name, version);
    request.onsuccess = () => {
      resolve(request.result);
    };
    request.onerror = () => {
      reject(request.error ?? new Error('open failed'));
    };
  });
}

export function deleteRaw(factory: IDBFactory, name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = factory.deleteDatabase(name);
    request.onsuccess = () => {
      resolve();
    };
    request.onerror = () => {
      reject(request.error ?? new Error('delete failed'));
    };
  });
}

export function openV1(factory: IDBFactory, now = 1_000): Promise<IDBDatabase> {
  return openVaultDb({ idb: factory, now: () => now, migrations: MIGRATIONS });
}

export function testMigrations(...extra: Migration[]): readonly Migration[] {
  return [...MIGRATIONS, ...extra];
}

/** Every record of every store, read without the vault code. */
export async function dumpAll(
  db: IDBDatabase,
): Promise<Map<string, unknown[]>> {
  const names = [...db.objectStoreNames];
  const transaction = db.transaction(names, 'readonly');
  const dump = new Map<string, unknown[]>();
  await Promise.all(
    names.map(
      (name) =>
        new Promise<void>((resolve, reject) => {
          const request = transaction.objectStore(name).getAll();
          request.onsuccess = () => {
            dump.set(name, request.result);
            resolve();
          };
          request.onerror = () => {
            reject(request.error ?? new Error('getAll failed'));
          };
        }),
    ),
  );
  return dump;
}

/** Puts a record directly (simulating corruption or a tampering attempt). */
export function putRaw(
  db: IDBDatabase,
  store: string,
  value: unknown,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(store, 'readwrite');
    transaction.objectStore(store).put(value);
    transaction.oncomplete = () => {
      resolve();
    };
    transaction.onabort = () => {
      reject(transaction.error ?? new Error('put aborted'));
    };
  });
}

export function clearRaw(db: IDBDatabase, store: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(store, 'readwrite');
    transaction.objectStore(store).clear();
    transaction.oncomplete = () => {
      resolve();
    };
    transaction.onabort = () => {
      reject(transaction.error ?? new Error('clear aborted'));
    };
  });
}

export function getRaw(
  db: IDBDatabase,
  store: string,
  key: IDBValidKey,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const request = db.transaction(store).objectStore(store).get(key);
    request.onsuccess = () => {
      resolve(request.result);
    };
    request.onerror = () => {
      reject(request.error ?? new Error('get failed'));
    };
  });
}

/** A real value with the normal form the detection module would send. */
export function realValue(fields: Omit<RealValue, 'normalised'>): RealValue {
  return {
    ...fields,
    normalised: normaliseReal(
      fields.type,
      fields.subtype,
      fields.country,
      fields.value,
    ),
  };
}

/** Byte and text forms a value could take if it were stored in the clear. */
export function needles(real: RealValue): string[] {
  const forms = new Set<string>([
    real.value,
    real.value.toLowerCase(),
    real.value.toUpperCase(),
    real.normalised,
  ]);
  const digits = real.value.replace(/\D/gu, '');
  if (digits.length >= 6) forms.add(digits);
  return [...forms];
}

/** Every place in a stored value where one of `forms` appears in plaintext. */
export function findPlaintext(
  value: unknown,
  forms: readonly string[],
  path = '$',
): string[] {
  if (typeof value === 'string') {
    return forms.some((form) => value.includes(form)) ? [path] : [];
  }
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
    const bytes =
      value instanceof ArrayBuffer
        ? Buffer.from(value)
        : Buffer.from(value.buffer, value.byteOffset, value.byteLength);
    const hit = forms.some(
      (form) =>
        bytes.includes(Buffer.from(form, 'utf8')) ||
        bytes.includes(Buffer.from(form, 'utf16le')),
    );
    return hit ? [path] : [];
  }
  if (typeof value === 'object' && value !== null) {
    return Object.entries(value).flatMap(([key, child]) => [
      ...(forms.some((form) => key.includes(form)) ? [`${path} key`] : []),
      ...findPlaintext(child, forms, `${path}.${key}`),
    ]);
  }
  return [];
}

/** An open vault with keys, as the service would hand to an operation. */
export async function readyContext(
  factory: IDBFactory = new IDBFactory(),
  now: () => number = () => 1_000,
): Promise<VaultContext> {
  const db = await openV1(factory);
  const state = await ensureKeys(db, webCrypto, now);
  if (state.status !== 'ready') throw new Error('keys not ready');
  return { db, crypto: webCrypto, keys: state.keys, now };
}

/** The VaultError code of a rejection, for assertions. */
export function codeOf(error: unknown): string {
  return error instanceof VaultError ? error.code : 'not a VaultError';
}
