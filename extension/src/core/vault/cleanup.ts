/**
 * Auto-delete: conversations unused for longer than the retention period
 * are deleted with their mappings, and log rows older than LOG_RETENTION_DAYS
 * whatever the setting. Needs no keys, so it also runs when they are lost.
 */
import { forEachCursor, requestResult, withTransaction } from './db.ts';
import { INDEX, STORE } from './schema.ts';

const DAY_MS = 86_400_000;

/** Log rows are kept this long. */
export const LOG_RETENTION_DAYS = 90;

export interface CleanupOptions {
  /** Days a conversation may stay unused; 0 keeps conversations forever. */
  retentionDays: number;
}

export interface CleanupResult {
  /** IDs of the deleted conversations. */
  conversations: string[];
  mappings: number;
  logRows: number;
}

/** Deletes expired conversations, their mappings and old log rows in one transaction. */
export async function deleteExpired(
  db: IDBDatabase,
  now: number,
  options: CleanupOptions,
): Promise<CleanupResult> {
  return withTransaction(
    db,
    [STORE.conversations, STORE.mappings, STORE.log, STORE.meta],
    'readwrite',
    async (transaction) => {
      const conversations: string[] = [];
      const expired: IDBValidKey[] = [];
      if (options.retentionDays > 0) {
        const cutoff = now - options.retentionDays * DAY_MS;
        // Ascending by lastUsedAt: stop at the first one still in use.
        await forEachCursor(
          transaction
            .objectStore(STORE.conversations)
            .index(INDEX.conversationsByLastUsedAt)
            .openCursor(),
          (cursor) => {
            if (typeof cursor.key !== 'number' || cursor.key >= cutoff) {
              return false;
            }
            expired.push(cursor.primaryKey);
            // Conversation IDs are strings; other keys are corrupt records.
            if (typeof cursor.primaryKey === 'string') {
              conversations.push(cursor.primaryKey);
            }
            cursor.delete();
            return true;
          },
        );
      }

      let mappings = 0;
      const mappingStore = transaction.objectStore(STORE.mappings);
      for (const id of expired) {
        const keys = await requestResult(
          mappingStore.index(INDEX.mappingsByConversation).getAllKeys(id),
        );
        for (const key of keys) {
          await requestResult(mappingStore.delete(key));
        }
        mappings += keys.length;
      }

      let logRows = 0;
      const logCutoff = now - LOG_RETENTION_DAYS * DAY_MS;
      await forEachCursor(
        transaction
          .objectStore(STORE.log)
          .index(INDEX.logByTimestamp)
          .openCursor(),
        (cursor) => {
          if (typeof cursor.key !== 'number' || cursor.key >= logCutoff) {
            return false;
          }
          cursor.delete();
          logRows += 1;
          return true;
        },
      );

      await requestResult(
        transaction
          .objectStore(STORE.meta)
          .put({ key: 'lastCleanupAt', value: now }),
      );
      return { conversations, mappings, logRows };
    },
  );
}
