/**
 * IndexedDB schema of the `promptveil` database. MIGRATIONS[i] upgrades
 * version i to version i + 1 inside the upgrade transaction, so a failed step
 * rolls the whole upgrade back. Later versions append a step; a step never
 * drops user mappings without moving them.
 */

export const DB_NAME = 'promptveil';

export const STORE = {
  keys: 'keys',
  conversations: 'conversations',
  mappings: 'mappings',
  log: 'log',
  customTerms: 'customTerms',
  meta: 'meta',
} as const;

export type StoreName = (typeof STORE)[keyof typeof STORE];

export const INDEX = {
  conversationsBySite: 'by_site',
  conversationsByLastUsedAt: 'by_lastUsedAt',
  mappingsByConversation: 'by_conversation',
  mappingsByConvRealHash: 'by_conv_realHash',
  mappingsByConvSurrogate: 'by_conv_surrogate',
  logByTimestamp: 'by_timestamp',
  logBySite: 'by_site',
  customTermsByList: 'by_list',
  customTermsByTermHash: 'by_termHash',
} as const;

export interface MigrationContext {
  db: IDBDatabase;
  transaction: IDBTransaction;
  now: number;
}

export type Migration = (context: MigrationContext) => void;

/** Records the version a migration step reached (call at the end of each step). */
export function setSchemaVersion(
  transaction: IDBTransaction,
  version: number,
): void {
  transaction
    .objectStore(STORE.meta)
    .put({ key: 'schemaVersion', value: version });
}

/** Version 1: every store and index of the schema. */
function createVersion1({ db, transaction, now }: MigrationContext): void {
  db.createObjectStore(STORE.keys, { keyPath: 'id' });

  const conversations = db.createObjectStore(STORE.conversations, {
    keyPath: 'id',
  });
  conversations.createIndex(INDEX.conversationsBySite, 'site');
  conversations.createIndex(INDEX.conversationsByLastUsedAt, 'lastUsedAt');

  const mappings = db.createObjectStore(STORE.mappings, { keyPath: 'id' });
  mappings.createIndex(INDEX.mappingsByConversation, 'conversationId');
  mappings.createIndex(
    INDEX.mappingsByConvRealHash,
    ['conversationId', 'realHash'],
    { unique: true },
  );
  mappings.createIndex(
    INDEX.mappingsByConvSurrogate,
    ['conversationId', 'surrogateNorm'],
    { unique: true },
  );

  const log = db.createObjectStore(STORE.log, {
    keyPath: 'id',
    autoIncrement: true,
  });
  log.createIndex(INDEX.logByTimestamp, 'timestamp');
  log.createIndex(INDEX.logBySite, 'site');

  const customTerms = db.createObjectStore(STORE.customTerms, {
    keyPath: 'id',
  });
  customTerms.createIndex(INDEX.customTermsByList, 'list');
  customTerms.createIndex(INDEX.customTermsByTermHash, 'termHash', {
    unique: true,
  });

  db.createObjectStore(STORE.meta, { keyPath: 'key' });
  setSchemaVersion(transaction, 1);
  transaction.objectStore(STORE.meta).put({ key: 'installedAt', value: now });
}

export const MIGRATIONS: readonly Migration[] = [createVersion1];
