/**
 * Opening the vault database and running transactions. The platform
 * IDBFactory is passed in (src/core never reads the global).
 */
import { toVaultError, VaultError } from './errors.ts';
import {
  DB_NAME,
  MIGRATIONS,
  type Migration,
  type StoreName,
} from './schema.ts';

export interface OpenVaultOptions {
  idb: IDBFactory;
  now: () => number;
  name?: string;
  /** Production uses MIGRATIONS; tests pass extra steps. */
  migrations?: readonly Migration[];
  /** How long to wait for old connections to close before failing. */
  blockedTimeoutMs?: number;
  /** The connection was closed because another context needs a new version or deletes the database. */
  onVersionChange?: () => void;
  /** The browser closed the connection (e.g. storage cleared). */
  onClose?: () => void;
}

const DEFAULT_BLOCKED_TIMEOUT_MS = 10_000;

/**
 * Opens (and if needed upgrades) the database. Our connections close as soon
 * as another context asks for a new version or deletes the database, so an
 * upgrade is only blocked by a context that does not; after the timeout this
 * rejects with `blocked`, and a connection that opens later is closed at
 * once. A failed migration step aborts the upgrade transaction, so the
 * database stays at its previous version with its data intact.
 */
export function openVaultDb(options: OpenVaultOptions): Promise<IDBDatabase> {
  const migrations = options.migrations ?? MIGRATIONS;
  const version = migrations.length;
  return new Promise((resolve, reject) => {
    let settled = false;
    let blockedTimer: ReturnType<typeof setTimeout> | undefined;
    let migrationError: unknown = null;

    const fail = (error: VaultError): void => {
      clearTimeout(blockedTimer);
      if (settled) return;
      settled = true;
      reject(error);
    };

    let request: IDBOpenDBRequest;
    try {
      request = options.idb.open(options.name ?? DB_NAME, version);
    } catch (error) {
      fail(toVaultError(error, 'unavailable'));
      return;
    }

    request.onupgradeneeded = (event) => {
      const transaction = request.transaction;
      if (transaction === null) {
        migrationError = new VaultError('upgrade-failed');
        return;
      }
      try {
        for (let step = event.oldVersion; step < version; step += 1) {
          const migrate = migrations[step];
          if (migrate === undefined) throw new VaultError('upgrade-failed');
          migrate({ db: request.result, transaction, now: options.now() });
        }
      } catch (error) {
        migrationError = error;
        transaction.abort();
      }
    };

    request.onblocked = () => {
      clearTimeout(blockedTimer);
      blockedTimer = setTimeout(() => {
        fail(new VaultError('blocked'));
      }, options.blockedTimeoutMs ?? DEFAULT_BLOCKED_TIMEOUT_MS);
    };

    request.onsuccess = () => {
      clearTimeout(blockedTimer);
      const db = request.result;
      if (settled) {
        // Opened after the caller was told it was blocked: nobody uses it.
        db.close();
        return;
      }
      settled = true;
      db.onversionchange = () => {
        db.close();
        options.onVersionChange?.();
      };
      db.onclose = () => {
        options.onClose?.();
      };
      resolve(db);
    };

    request.onerror = () => {
      fail(
        migrationError === null
          ? toVaultError(request.error, 'unavailable')
          : new VaultError('upgrade-failed', { cause: migrationError }),
      );
    };
  });
}

/** Resolves with a request's result; rejects with a VaultError. */
export function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => {
      resolve(request.result);
    };
    request.onerror = () => {
      reject(toVaultError(request.error, 'aborted'));
    };
  });
}

/**
 * Aborts a transaction unless it is already ending. A failed request aborts
 * its transaction by itself, before the abort event is delivered; abort()
 * then throws InvalidStateError, which means the outcome we want is already
 * under way.
 */
function abortIfActive(transaction: IDBTransaction): void {
  try {
    transaction.abort();
  } catch (error) {
    const alreadyEnding =
      typeof error === 'object' &&
      error !== null &&
      'name' in error &&
      error.name === 'InvalidStateError';
    if (!alreadyEnding) throw error;
  }
}

/**
 * Runs `body` in one transaction and resolves after it commits. If `body`
 * throws, the transaction is aborted (nothing it wrote is kept) and the
 * body's error is rethrown as a VaultError.
 *
 * `body` may await only requests of this transaction: awaiting anything else
 * (e.g. Web Crypto) lets the transaction commit early.
 */
export async function withTransaction<T>(
  db: IDBDatabase,
  stores: readonly StoreName[],
  mode: IDBTransactionMode,
  body: (transaction: IDBTransaction) => Promise<T>,
): Promise<T> {
  let transaction: IDBTransaction;
  try {
    transaction = db.transaction(stores, mode);
  } catch (error) {
    throw toVaultError(error, 'closed');
  }
  // Resolves when the transaction ends: null after a commit, the abort reason otherwise.
  const ended = new Promise<VaultError | null>((resolve) => {
    transaction.oncomplete = () => {
      resolve(null);
    };
    transaction.onabort = () => {
      resolve(toVaultError(transaction.error, 'aborted'));
    };
  });
  let result: T;
  try {
    result = await body(transaction);
  } catch (error) {
    abortIfActive(transaction);
    // Wait until the abort has taken effect; `error` is the cause to report.
    await ended;
    throw toVaultError(error, 'aborted');
  }
  const abortError = await ended;
  if (abortError !== null) throw abortError;
  return result;
}

/**
 * Walks a cursor request to its end, calling `visit` for each position
 * (it may update or delete the record). `visit` returns false to stop early.
 */
export function forEachCursor(
  request: IDBRequest<IDBCursorWithValue | null>,
  visit: (cursor: IDBCursorWithValue) => boolean | undefined,
): Promise<void> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => {
      const cursor = request.result;
      if (cursor === null) {
        resolve();
        return;
      }
      try {
        if (visit(cursor) === false) {
          resolve();
          return;
        }
        cursor.continue();
      } catch (error) {
        reject(toVaultError(error, 'aborted'));
      }
    };
    request.onerror = () => {
      reject(toVaultError(request.error, 'aborted'));
    };
  });
}

export interface DeleteVaultOptions {
  idb: IDBFactory;
  name?: string;
  blockedTimeoutMs?: number;
}

/**
 * Deletes the database. Our own connections close on the versionchange this
 * causes; a connection that does not close makes it fail with `blocked`
 * after the timeout (the deletion then still happens once it closes).
 */
export function deleteVaultDb(options: DeleteVaultOptions): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let blockedTimer: ReturnType<typeof setTimeout> | undefined;
    const settle = (error: VaultError | null): void => {
      clearTimeout(blockedTimer);
      if (settled) return;
      settled = true;
      if (error === null) resolve();
      else reject(error);
    };
    let request: IDBOpenDBRequest;
    try {
      request = options.idb.deleteDatabase(options.name ?? DB_NAME);
    } catch (error) {
      settle(toVaultError(error, 'unavailable'));
      return;
    }
    request.onsuccess = () => {
      settle(null);
    };
    request.onerror = () => {
      settle(toVaultError(request.error, 'unavailable'));
    };
    request.onblocked = () => {
      clearTimeout(blockedTimer);
      blockedTimer = setTimeout(() => {
        settle(new VaultError('blocked'));
      }, options.blockedTimeoutMs ?? DEFAULT_BLOCKED_TIMEOUT_MS);
    };
  });
}
