/**
 * The vault as the service worker uses it: one database connection and one
 * key set per worker lifetime, opened on first use. MV3 stops idle workers;
 * a restarted worker simply opens again. If another context upgrades or
 * deletes the database, or the browser closes the connection, the cached
 * connection and keys are dropped and the next operation opens afresh.
 */
import type { Mapping } from '@/src/shared/entities.ts';
import {
  deleteExpired,
  type CleanupOptions,
  type CleanupResult,
} from './cleanup.ts';
import { deleteVaultDb, openVaultDb } from './db.ts';
import { VaultError } from './errors.ts';
import { ensureKeys, type KeyState } from './keys.ts';
import {
  createConversation,
  findByReal,
  insertMapping,
  isStandInTaken,
  loadConversation,
  type InsertResult,
  type LoadedConversation,
  type NewConversation,
  type NewMapping,
  type RealValue,
  type VaultContext,
} from './mappings.ts';
import {
  maskValues,
  type MaskRequest,
  type MaskResult,
  type StandInGenerator,
} from './mask.ts';
import { migrateConversation, type MigrationOutcome } from './migrate.ts';
import type { Migration } from './schema.ts';
import type { ConversationRecord } from './types.ts';

export interface VaultDeps {
  idb: IDBFactory;
  crypto: Crypto;
  now?: () => number;
  /** Tests only: database name and migration steps. */
  name?: string;
  migrations?: readonly Migration[];
  blockedTimeoutMs?: number;
}

export interface VaultService {
  /** Opens the database and loads or creates the keys; reports `keys-lost` as a state. */
  ensureKeys(): Promise<KeyState>;
  createConversation(input: NewConversation): Promise<ConversationRecord>;
  findByReal(conversationId: string, real: RealValue): Promise<Mapping | null>;
  isStandInTaken(conversationId: string, surrogate: string): Promise<boolean>;
  insertMapping(input: NewMapping): Promise<InsertResult>;
  loadConversation(conversationId: string): Promise<LoadedConversation>;
  /** Stand-ins for every item of a send (see mask.ts). */
  maskValues(
    request: MaskRequest,
    generate?: StandInGenerator,
  ): Promise<MaskResult>;
  /** Moves a pending chat to the ID the site assigned (see migrate.ts). */
  migrate(from: string, to: string): Promise<MigrationOutcome>;
  /** Auto-delete (see cleanup.ts); works without keys. */
  deleteExpired(options: CleanupOptions): Promise<CleanupResult>;
  /**
   * Deletes the whole database (mappings, conversations, log, custom terms,
   * keys). The next operation opens a fresh one and creates new keys.
   */
  deleteDatabase(): Promise<void>;
  /** Closes the connection; the next operation opens it again. */
  close(): void;
}

export function createVaultService(deps: VaultDeps): VaultService {
  const now = deps.now ?? Date.now;
  let connection: Promise<IDBDatabase> | null = null;
  let keyState: Promise<KeyState> | null = null;
  // Bumped whenever the connection is dropped, so a result that arrives for
  // an older connection is never cached.
  let generation = 0;

  const drop = (): void => {
    generation += 1;
    connection = null;
    keyState = null;
  };

  const database = (): Promise<IDBDatabase> => {
    if (connection === null) {
      const opened = generation;
      connection = openVaultDb({
        idb: deps.idb,
        now,
        name: deps.name,
        migrations: deps.migrations,
        blockedTimeoutMs: deps.blockedTimeoutMs,
        onVersionChange: drop,
        onClose: drop,
      });
      // A failed open is not cached: the next operation tries again.
      connection.catch(() => {
        if (generation === opened) drop();
      });
    }
    return connection;
  };

  const keys = (): Promise<KeyState> => {
    if (keyState === null) {
      const loading = generation;
      keyState = database().then((db) => ensureKeys(db, deps.crypto, now));
      keyState.then(
        (state) => {
          // keys-lost is re-checked on every call, so a repaired vault is seen.
          if (state.status !== 'ready' && generation === loading) {
            keyState = null;
          }
        },
        () => {
          if (generation === loading) keyState = null;
        },
      );
    }
    return keyState;
  };

  const context = async (): Promise<VaultContext> => {
    const state = await keys();
    if (state.status !== 'ready') throw new VaultError('keys-lost');
    return { db: await database(), crypto: deps.crypto, keys: state.keys, now };
  };

  const close = (): void => {
    const current = connection;
    drop();
    if (current !== null) {
      void current.then(
        (db) => {
          db.close();
        },
        // A connection that failed to open has nothing to close; the
        // failure was already reported to the operation that opened it.
        () => undefined,
      );
    }
  };

  return {
    ensureKeys: keys,
    createConversation: async (input) =>
      createConversation(await context(), input),
    findByReal: async (conversationId, real) =>
      findByReal(await context(), conversationId, real),
    isStandInTaken: async (conversationId, surrogate) =>
      isStandInTaken(await context(), conversationId, surrogate),
    insertMapping: async (input) => insertMapping(await context(), input),
    loadConversation: async (conversationId) =>
      loadConversation(await context(), conversationId),
    maskValues: async (request, generate) =>
      maskValues(await context(), request, generate),
    migrate: async (from, to) => migrateConversation(await context(), from, to),
    deleteExpired: async (options) =>
      deleteExpired(await database(), now(), options),
    deleteDatabase: async () => {
      // Transactions already running finish first; the deletion waits for
      // the connection to close.
      close();
      await deleteVaultDb({
        idb: deps.idb,
        name: deps.name,
        blockedTimeoutMs: deps.blockedTimeoutMs,
      });
    },
    close,
  };
}
