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
import {
  commitMask,
  prepareMask,
  type CommitEntry,
  type CommitResult,
  type PrepareRequest,
  type PrepareResult,
} from '@/src/core/vault/mask.ts';
import { MIGRATIONS, type Migration } from '@/src/core/vault/schema.ts';
import type { VaultService } from '@/src/core/vault/service.ts';
import { generateStandIn, StandInError } from '@/src/core/surrogate/engine.ts';

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

/** Generates a candidate stand-in for a new value (null: try the next attempt). */
export type TestGenerator = (
  real: RealValue,
  prepared: { seed: Uint8Array; number: number; dateOffsetDays: number },
  attempt: number,
) => { value: string; normalised: string } | null;

/**
 * The production stand-in engine for the types it covers; other types get
 * a numbered placeholder (they have no generator yet).
 */
export const engineGenerator: TestGenerator = (real, prepared, attempt) => {
  try {
    return generateStandIn(
      {
        ...real,
        dateOffsetDays: prepared.dateOffsetDays,
        number: prepared.number,
        now: Date.UTC(2026, 10, 11),
      },
      prepared.seed,
      attempt,
    );
  } catch (error) {
    if (!(error instanceof StandInError)) throw error;
    const value = `${real.type.toLowerCase()} stand-in ${(prepared.number + attempt).toString()}`;
    return { value, normalised: value };
  }
};

/** Numbered email-style stand-ins, ignoring the seed (for collision tests). */
export function numbered(pick: (number: number) => string): TestGenerator {
  return (real, prepared, attempt) => {
    const value = pick(prepared.number + attempt);
    return {
      value,
      normalised: normaliseReal(real.type, real.subtype, real.country, value),
    };
  };
}

interface MaskOps {
  prepare(request: PrepareRequest): Promise<PrepareResult>;
  commit(
    conversationId: string,
    entries: readonly CommitEntry[],
  ): Promise<CommitResult>;
}

/** Up to this many attempts per value, as the masker allows. */
const ATTEMPTS = 20;

async function maskThrough(
  ops: MaskOps,
  request: PrepareRequest,
  generate: TestGenerator,
): Promise<{ standIns: string[]; inserted: number }> {
  const prepared = await ops.prepare(request);
  const standIns: string[] = [];
  let inserted = 0;
  for (const [index, value] of prepared.values.entries()) {
    const real = request.items[index];
    if (real === undefined) throw new Error('missing item');
    if (value.kind === 'existing') {
      standIns.push(value.standIn);
      continue;
    }
    let standIn: string | null = null;
    for (
      let attempt = 0;
      attempt < ATTEMPTS && standIn === null;
      attempt += 1
    ) {
      const candidate = generate(
        real,
        { ...value, dateOffsetDays: prepared.dateOffsetDays },
        attempt,
      );
      if (candidate === null) continue;
      const result = await ops.commit(request.conversationId, [
        {
          real,
          standIn: candidate.value,
          standInNormalised: candidate.normalised,
        },
      ]);
      const [outcome] = result.values;
      if (outcome === undefined) throw new Error('no outcome');
      if (outcome.kind !== 'taken') {
        standIn = outcome.standIn;
        inserted += result.inserted;
      }
    }
    if (standIn === null) throw new Error('every attempt was taken');
    standIns.push(standIn);
  }
  return { standIns, inserted };
}

/** prepareMask + commitMask on a context, as the content script drives them. */
export function maskValues(
  context: VaultContext,
  request: PrepareRequest,
  generate: TestGenerator = engineGenerator,
): Promise<{ standIns: string[]; inserted: number }> {
  return maskThrough(
    {
      prepare: (r) => prepareMask(context, r),
      commit: (conversationId, entries) =>
        commitMask(context, conversationId, entries),
    },
    request,
    generate,
  );
}

/** The same through the vault service. */
export function maskWithService(
  vault: VaultService,
  request: PrepareRequest,
  generate: TestGenerator = engineGenerator,
): Promise<{ standIns: string[]; inserted: number }> {
  return maskThrough(
    {
      prepare: (r) => vault.prepareMask(r),
      commit: (conversationId, entries) =>
        vault.commitMask(conversationId, entries),
    },
    request,
    generate,
  );
}
