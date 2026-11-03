/**
 * Moving a pending chat to the conversation ID the site assigned to it.
 *
 * A new chat has no ID until its first message is sent, so its mappings are
 * stored under `{site}:pending:{uuid}`. Both the additional data of each
 * ciphertext and each realHash name the conversation, so moving a mapping
 * means decrypting, re-encrypting and re-hashing it. Web Crypto cannot run
 * inside a transaction (the transaction would commit early), so this
 * happens in two steps:
 *
 * 1. prepareMigration reads the pending chat and derives every moved record
 *    in memory;
 * 2. commitMigration writes them in ONE transaction, after checking that the
 *    pending chat's records are exactly the ones step 1 read. If they
 *    changed meanwhile it writes nothing and reports `changed`, and the
 *    caller prepares again.
 *
 * A conflict with a record already in the target conversation (the unique
 * indexes) aborts the whole transaction, so the old state stays as it was.
 */
import type { EncryptedValue, Mapping } from '@/src/shared/entities.ts';
import {
  decryptReal,
  encryptReal,
  realHash,
  type SealedReal,
} from './crypto.ts';
import { forEachCursor, requestResult, withTransaction } from './db.ts';
import { toBase64 } from './encoding.ts';
import { VaultError } from './errors.ts';
import { mappingBinding, type VaultContext } from './mappings.ts';
import { isConversationRecord, isMappingRecord } from './records.ts';
import { INDEX, STORE } from './schema.ts';
import type { ConversationRecord } from './types.ts';

/** Prepare-and-commit rounds before a migration that keeps changing fails. */
export const MAX_MIGRATION_ATTEMPTS = 3;

interface MovedFields {
  realHash: string;
  realEnc: EncryptedValue;
}

export interface MigrationPlan {
  readonly from: string;
  readonly to: string;
  /** Fingerprints of the pending chat's records at prepare time, in index order. */
  readonly fingerprints: readonly string[];
  /** Re-encrypted and re-hashed fields per record id. */
  readonly moved: ReadonlyMap<string, MovedFields>;
  /**
   * How many records are malformed or fail authentication. They can never
   * be shown and cannot be re-encrypted, so they are deleted with the move.
   */
  readonly dropped: number;
}

export type MigrationOutcome =
  | { status: 'migrated'; count: number; dropped: number }
  /** No pending conversation (already moved, deleted, or never stored). */
  | { status: 'nothing' };

type CommitOutcome = MigrationOutcome | { status: 'changed' };

interface StoredRecord {
  key: IDBValidKey;
  value: unknown;
}

/**
 * Identifies the content a moved record was derived from. Malformed records
 * are deleted with the move whatever they hold, so they share one marker.
 */
function fingerprint(record: StoredRecord): string {
  const { value } = record;
  if (!isMappingRecord(value)) return 'malformed';
  return [
    value.id,
    value.type,
    value.subtype ?? '',
    toBase64(value.realEnc.iv),
    toBase64(new Uint8Array(value.realEnc.ct)),
  ].join('|');
}

function readRecords(
  transaction: IDBTransaction,
  conversationId: string,
): Promise<StoredRecord[]> {
  const records: StoredRecord[] = [];
  return forEachCursor(
    transaction
      .objectStore(STORE.mappings)
      .index(INDEX.mappingsByConversation)
      .openCursor(conversationId),
    (cursor) => {
      records.push({ key: cursor.primaryKey, value: cursor.value });
      return true;
    },
  ).then(() => records);
}

async function readConversation(
  transaction: IDBTransaction,
  id: string,
): Promise<ConversationRecord | null> {
  const record: unknown = await requestResult(
    transaction.objectStore(STORE.conversations).get(id),
  );
  if (record === undefined) return null;
  if (!isConversationRecord(record)) throw new VaultError('corrupt-record');
  return record;
}

/** Step 1: reads the pending chat and derives the moved records in memory. */
export async function prepareMigration(
  context: VaultContext,
  from: string,
  to: string,
): Promise<MigrationPlan | null> {
  const snapshot = await withTransaction(
    context.db,
    [STORE.conversations, STORE.mappings],
    'readonly',
    async (transaction) => {
      const conversation = await readConversation(transaction, from);
      if (conversation === null) return null;
      return readRecords(transaction, from);
    },
  );
  if (snapshot === null) return null;

  const fingerprints: string[] = [];
  const moved = new Map<string, MovedFields>();
  let dropped = 0;
  for (const record of snapshot) {
    fingerprints.push(fingerprint(record));
    const { value } = record;
    if (!isMappingRecord(value)) {
      dropped += 1;
      continue;
    }
    let sealed: SealedReal;
    try {
      sealed = await decryptReal(
        context.crypto,
        context.keys.enc,
        value.realEnc,
        mappingBinding(value),
      );
    } catch (error) {
      if (error instanceof VaultError && error.code === 'decrypt-failed') {
        dropped += 1;
        continue;
      }
      throw error;
    }
    const target = { ...value, conversationId: to };
    moved.set(value.id, {
      realHash: await realHash(context.crypto, context.keys.lookup, {
        conversationId: to,
        type: value.type,
        subtype: value.subtype,
        normalised: sealed.normalised,
      }),
      realEnc: await encryptReal(
        context.crypto,
        context.keys.enc,
        sealed,
        mappingBinding(target),
      ),
    });
  }
  return { from, to, fingerprints, moved, dropped };
}

function sameRecords(
  plan: MigrationPlan,
  current: readonly StoredRecord[],
): boolean {
  // Both lists are in index order (conversation, then primary key).
  return (
    current.length === plan.fingerprints.length &&
    current.every(
      (record, index) => plan.fingerprints[index] === fingerprint(record),
    )
  );
}

/** Points the pending chat's log rows at the new conversation. */
function moveLogRows(
  transaction: IDBTransaction,
  from: string,
  to: string,
): Promise<void> {
  return forEachCursor(
    transaction.objectStore(STORE.log).openCursor(),
    (cursor) => {
      const row: unknown = cursor.value;
      if (
        typeof row === 'object' &&
        row !== null &&
        'conversationId' in row &&
        row.conversationId === from
      ) {
        cursor.update({ ...row, conversationId: to });
      }
      return true;
    },
  );
}

/** Step 2: writes the plan in one transaction if the pending chat is unchanged. */
export async function commitMigration(
  context: VaultContext,
  plan: MigrationPlan,
): Promise<CommitOutcome> {
  const now = context.now();
  return withTransaction(
    context.db,
    [STORE.conversations, STORE.mappings, STORE.log],
    'readwrite',
    async (transaction): Promise<CommitOutcome> => {
      const source = await readConversation(transaction, plan.from);
      if (source === null) return { status: 'nothing' };
      const current = await readRecords(transaction, plan.from);
      if (!sameRecords(plan, current)) return { status: 'changed' };

      const conversations = transaction.objectStore(STORE.conversations);
      const target = await readConversation(transaction, plan.to);
      const count = plan.moved.size;
      // A new target keeps the pending chat's date offset: date stand-ins
      // already sent were shifted by it.
      const updated: ConversationRecord =
        target === null
          ? {
              ...source,
              id: plan.to,
              status: 'active',
              lastUsedAt: Math.max(source.lastUsedAt, now),
              mappingCount: count,
            }
          : {
              ...target,
              lastUsedAt: Math.max(target.lastUsedAt, source.lastUsedAt, now),
              mappingCount: target.mappingCount + count,
            };
      await requestResult(conversations.put(updated));

      const mappings = transaction.objectStore(STORE.mappings);
      for (const record of current) {
        const { value } = record;
        const fields = isMappingRecord(value)
          ? plan.moved.get(value.id)
          : undefined;
        if (!isMappingRecord(value) || fields === undefined) {
          await requestResult(mappings.delete(record.key));
          continue;
        }
        const next: Mapping = { ...value, conversationId: plan.to, ...fields };
        await requestResult(mappings.put(next));
      }
      await requestResult(conversations.delete(plan.from));
      await moveLogRows(transaction, plan.from, plan.to);
      return { status: 'migrated', count, dropped: plan.dropped };
    },
  );
}

/**
 * Moves a pending chat to its conversation ID, preparing again when the
 * pending chat changed between the two steps.
 */
export async function migrateConversation(
  context: VaultContext,
  from: string,
  to: string,
): Promise<MigrationOutcome> {
  for (let attempt = 0; attempt < MAX_MIGRATION_ATTEMPTS; attempt += 1) {
    const plan = await prepareMigration(context, from, to);
    if (plan === null) return { status: 'nothing' };
    const outcome = await commitMigration(context, plan);
    if (outcome.status !== 'changed') return outcome;
  }
  throw new VaultError('aborted');
}
