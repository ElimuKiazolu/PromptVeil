/**
 * Mappings repository: one real value and its stand-in per conversation.
 * Real values are stored only encrypted; they are found by realHash and
 * decrypted only in memory (loadConversation).
 */
import type { CountryCode } from '@/src/shared/country.ts';
import type {
  DetectionSource,
  EntitySubtype,
  EntityType,
  Mapping,
} from '@/src/shared/entities.ts';
import type { SiteId } from '@/src/shared/settings.ts';
import {
  decryptValue,
  encryptValue,
  randomDateOffsetDays,
  realHash,
  type RecordBinding,
} from './crypto.ts';
import { requestResult, withTransaction } from './db.ts';
import { VaultError } from './errors.ts';
import { normaliseReal, normaliseStandIn } from './normalise.ts';
import { isConversationRecord, isMappingRecord } from './records.ts';
import { INDEX, STORE } from './schema.ts';
import type {
  ConversationRecord,
  ConversationStatus,
  VaultKeys,
} from './types.ts';

export interface VaultContext {
  db: IDBDatabase;
  crypto: Crypto;
  keys: VaultKeys;
  now: () => number;
}

/** A real value as detected (plaintext; memory only). */
export interface RealValue {
  type: EntityType;
  subtype: EntitySubtype | null;
  country: CountryCode | null;
  value: string;
}

export interface NewConversation {
  id: string;
  site: SiteId;
  status: ConversationStatus;
}

/** Returns the conversation, creating it if it does not exist yet. */
export async function createConversation(
  context: VaultContext,
  input: NewConversation,
): Promise<ConversationRecord> {
  const now = context.now();
  const record: ConversationRecord = {
    ...input,
    dateOffsetDays: randomDateOffsetDays(context.crypto),
    createdAt: now,
    lastUsedAt: now,
    mappingCount: 0,
  };
  return withTransaction(
    context.db,
    [STORE.conversations],
    'readwrite',
    async (transaction) => {
      const store = transaction.objectStore(STORE.conversations);
      const existing: unknown = await requestResult(store.get(input.id));
      if (existing !== undefined) {
        if (!isConversationRecord(existing)) {
          throw new VaultError('corrupt-record');
        }
        return existing;
      }
      await requestResult(store.add(record));
      return record;
    },
  );
}

async function hashOf(
  context: VaultContext,
  conversationId: string,
  real: RealValue,
): Promise<string> {
  return realHash(context.crypto, context.keys.lookup, {
    conversationId,
    type: real.type,
    subtype: real.subtype,
    normalised: normaliseReal(
      real.type,
      real.subtype,
      real.country,
      real.value,
    ),
  });
}

/** Marks the conversation as used now; `delta` new mappings. */
async function touchConversation(
  transaction: IDBTransaction,
  conversationId: string,
  now: number,
  delta: number,
): Promise<void> {
  const store = transaction.objectStore(STORE.conversations);
  const conversation: unknown = await requestResult(store.get(conversationId));
  if (conversation === undefined) throw new VaultError('no-conversation');
  if (!isConversationRecord(conversation)) {
    throw new VaultError('corrupt-record');
  }
  await requestResult(
    store.put({
      ...conversation,
      lastUsedAt: now,
      mappingCount: conversation.mappingCount + delta,
    }),
  );
}

/**
 * The conversation's mapping for this real value, or null. A hit counts as a
 * reuse (hitCount + 1) and marks the conversation as used.
 */
export async function findByReal(
  context: VaultContext,
  conversationId: string,
  real: RealValue,
): Promise<Mapping | null> {
  const hash = await hashOf(context, conversationId, real);
  const now = context.now();
  return withTransaction(
    context.db,
    [STORE.mappings, STORE.conversations],
    'readwrite',
    async (transaction) => {
      const store = transaction.objectStore(STORE.mappings);
      const found: unknown = await requestResult(
        store.index(INDEX.mappingsByConvRealHash).get([conversationId, hash]),
      );
      if (found === undefined) return null;
      if (!isMappingRecord(found)) throw new VaultError('corrupt-record');
      const reused: Mapping = { ...found, hitCount: found.hitCount + 1 };
      await requestResult(store.put(reused));
      await touchConversation(transaction, conversationId, now, 0);
      return reused;
    },
  );
}

/** Whether a stand-in (in any separator or case form) is already used in the conversation. */
export async function isStandInTaken(
  context: VaultContext,
  conversationId: string,
  surrogate: string,
): Promise<boolean> {
  return withTransaction(
    context.db,
    [STORE.mappings],
    'readonly',
    async (transaction) => {
      const count = await requestResult(
        transaction
          .objectStore(STORE.mappings)
          .index(INDEX.mappingsByConvSurrogate)
          .count([conversationId, normaliseStandIn(surrogate)]),
      );
      return count > 0;
    },
  );
}

export interface NewMapping {
  conversationId: string;
  real: RealValue;
  /** The stand-in exactly as it will be sent. */
  surrogate: string;
  /** Stand-in-side forms only. */
  variants: readonly string[];
  locale: string | null;
  parentId: string | null;
  source: DetectionSource;
  confidence: number;
}

export type InsertResult =
  | { status: 'inserted'; mapping: Mapping }
  /** The value was stored meanwhile (e.g. by another tab); that mapping is reused. */
  | { status: 'existing'; mapping: Mapping }
  /** The stand-in is already used for another value; generate another one. */
  | { status: 'surrogate-taken' };

function binding(mapping: {
  id: string;
  conversationId: string;
  type: EntityType;
  subtype: EntitySubtype | null;
}): RecordBinding {
  return {
    store: 'mappings',
    recordId: mapping.id,
    conversationId: mapping.conversationId,
    type: mapping.type,
    subtype: mapping.subtype,
  };
}

/**
 * Stores a new mapping and counts it on its conversation (which must exist).
 * Two concurrent inserts of one real value end with one mapping: the unique
 * index rejects the second, which then returns the first as `existing`.
 */
export async function insertMapping(
  context: VaultContext,
  input: NewMapping,
): Promise<InsertResult> {
  const { real, conversationId } = input;
  const id = context.crypto.randomUUID();
  const now = context.now();
  const mapping: Mapping = {
    id,
    conversationId,
    type: real.type,
    subtype: real.subtype,
    country: real.country,
    locale: input.locale,
    realHash: await hashOf(context, conversationId, real),
    realEnc: await encryptValue(
      context.crypto,
      context.keys.enc,
      real.value,
      binding({ id, conversationId, type: real.type, subtype: real.subtype }),
    ),
    surrogate: input.surrogate,
    surrogateNorm: normaliseStandIn(input.surrogate),
    variants: [...input.variants],
    parentId: input.parentId,
    source: input.source,
    confidence: input.confidence,
    createdAt: now,
    hitCount: 0,
  };
  try {
    await withTransaction(
      context.db,
      [STORE.mappings, STORE.conversations],
      'readwrite',
      async (transaction) => {
        await touchConversation(transaction, conversationId, now, 1);
        await requestResult(
          transaction.objectStore(STORE.mappings).add(mapping),
        );
      },
    );
    return { status: 'inserted', mapping };
  } catch (error) {
    if (!(error instanceof VaultError) || error.code !== 'constraint') {
      throw error;
    }
    const existing = await findByReal(context, conversationId, real);
    if (existing !== null) return { status: 'existing', mapping: existing };
    if (await isStandInTaken(context, conversationId, input.surrogate)) {
      return { status: 'surrogate-taken' };
    }
    throw error;
  }
}

/** A mapping with its real value decrypted (memory only). */
export interface RestoreEntry {
  mappingId: string;
  type: EntityType;
  subtype: EntitySubtype | null;
  country: CountryCode | null;
  surrogate: string;
  variants: readonly string[];
  parentId: string | null;
  real: string;
}

export interface LoadedConversation {
  entries: RestoreEntry[];
  /** Records that were malformed or failed authentication; never shown. */
  failed: number;
}

/** Decrypts every mapping of a conversation into memory. */
export async function loadConversation(
  context: VaultContext,
  conversationId: string,
): Promise<LoadedConversation> {
  const records = await withTransaction(
    context.db,
    [STORE.mappings],
    'readonly',
    (transaction) =>
      requestResult<unknown[]>(
        transaction
          .objectStore(STORE.mappings)
          .index(INDEX.mappingsByConversation)
          .getAll(conversationId),
      ),
  );
  const entries: RestoreEntry[] = [];
  let failed = 0;
  for (const record of records) {
    if (!isMappingRecord(record) || record.conversationId !== conversationId) {
      failed += 1;
      continue;
    }
    let real: string;
    try {
      real = await decryptValue(
        context.crypto,
        context.keys.enc,
        record.realEnc,
        binding(record),
      );
    } catch (error) {
      // Counted in `failed`; any other kind of error is not expected here.
      if (error instanceof VaultError && error.code === 'decrypt-failed') {
        failed += 1;
        continue;
      }
      throw error;
    }
    entries.push({
      mappingId: record.id,
      type: record.type,
      subtype: record.subtype,
      country: record.country,
      surrogate: record.surrogate,
      variants: record.variants,
      parentId: record.parentId,
      real,
    });
  }
  return { entries, failed };
}
