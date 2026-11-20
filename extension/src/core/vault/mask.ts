/**
 * Masking against the vault, in two steps, so stand-ins can be generated
 * where the phone library and the prompt are (the content script, through
 * the detection module) while the keys and records stay here:
 *
 * 1. prepareMask: each value's stored stand-in, or (new value) its seed,
 *    HMAC(seed key, conversation, type, normal form) (TR-S1), and the
 *    mapping number; plus the conversation's date offset. With `create`, a
 *    missing conversation is created; without it (peekMask, while the user
 *    types) nothing is written.
 * 2. commitMask: stores each generated stand-in with its real value, unless
 *    the stand-in is taken: used for another value, or equal to a real value
 *    of the conversation (by hash). The caller then tries its next attempt.
 *    It also counts the reuse of stored values and marks the conversation as
 *    used, so every send commits once.
 *
 * Each step is one IndexedDB transaction, whatever the number of values:
 * hashes, seeds and encryptions are computed before it (Web Crypto inside a
 * transaction would let it commit early), and every check runs inside it,
 * so concurrent tabs still end with one mapping per value and one value per
 * stand-in.
 *
 * Every tab and every later page load sends the same stand-in for the same
 * value in a conversation, because the first one stored wins.
 */
import type { Mapping } from '@/src/shared/entities.ts';
import type { SiteId } from '@/src/shared/settings.ts';
import { encryptReal, seedFor } from './crypto.ts';
import { requestResult, withTransaction } from './db.ts';
import { VaultError } from './errors.ts';
import {
  hashOf,
  mappingBinding,
  newConversationRecord,
  type RealValue,
  type VaultContext,
} from './mappings.ts';
import { normaliseStandIn } from './normalise.ts';
import { isConversationRecord, isMappingRecord } from './records.ts';
import { INDEX, STORE } from './schema.ts';
import type { ConversationRecord, ConversationStatus } from './types.ts';

export interface PrepareRequest {
  conversationId: string;
  site: SiteId;
  /** Status of the conversation if it has to be created. */
  status: ConversationStatus;
  items: readonly RealValue[];
}

export type PreparedValue =
  /** Stored: its stand-in and stand-in-side variants (a DOB's order). */
  | { kind: 'existing'; standIn: string; variants: string[] }
  | {
      kind: 'new';
      /** 32 bytes; the stand-in engine's seed for this value. */
      seed: Uint8Array;
      /** The mapping's number if stored now (1 for the first). */
      number: number;
    };

export interface PrepareResult {
  /** Null when peeking at a conversation that does not exist yet. */
  dateOffsetDays: number | null;
  /** One per item, in order. */
  values: PreparedValue[];
}

function conversationOf(record: unknown): ConversationRecord | null {
  if (record === undefined) return null;
  if (!isConversationRecord(record)) throw new VaultError('corrupt-record');
  return record;
}

function mappingOf(record: unknown): Mapping | null {
  if (record === undefined) return null;
  if (!isMappingRecord(record)) throw new VaultError('corrupt-record');
  return record;
}

/** Looks the items up; `fresh` is stored if the conversation is missing. */
async function lookUp(
  context: VaultContext,
  conversationId: string,
  items: readonly RealValue[],
  fresh: ConversationRecord | null,
): Promise<PrepareResult> {
  const [hashes, seeds] = await Promise.all([
    Promise.all(items.map((real) => hashOf(context, conversationId, real))),
    Promise.all(
      items.map((real) =>
        seedFor(context.crypto, context.keys.seed, {
          conversationId,
          type: real.type,
          normalised: real.normalised,
        }),
      ),
    ),
  ]);
  const stores = [STORE.conversations, STORE.mappings] as const;
  const { conversation, found } = await withTransaction(
    context.db,
    stores,
    fresh === null ? 'readonly' : 'readwrite',
    async (transaction) => {
      const conversations = transaction.objectStore(STORE.conversations);
      let stored = conversationOf(
        await requestResult(conversations.get(conversationId)),
      );
      if (stored === null && fresh !== null) {
        await requestResult(conversations.add(fresh));
        stored = fresh;
      }
      const index = transaction
        .objectStore(STORE.mappings)
        .index(INDEX.mappingsByConvRealHash);
      const mappings: (Mapping | null)[] = [];
      for (const hash of hashes) {
        mappings.push(
          mappingOf(await requestResult(index.get([conversationId, hash]))),
        );
      }
      return { conversation: stored, found: mappings };
    },
  );

  const values: PreparedValue[] = [];
  let count = conversation?.mappingCount ?? 0;
  for (const [index, mapping] of found.entries()) {
    const seed = seeds[index];
    if (seed === undefined) throw new RangeError('missing seed');
    if (mapping !== null) {
      values.push({
        kind: 'existing',
        standIn: mapping.surrogate,
        variants: [...mapping.variants],
      });
      continue;
    }
    count += 1;
    values.push({ kind: 'new', seed, number: count });
  }
  return { dateOffsetDays: conversation?.dateOffsetDays ?? null, values };
}

/**
 * Creates the conversation if needed and looks every item up, in one
 * transaction. Values new to the conversation are numbered in order after
 * its stored mappings.
 */
export async function prepareMask(
  context: VaultContext,
  request: PrepareRequest,
): Promise<PrepareResult & { dateOffsetDays: number }> {
  const result = await lookUp(
    context,
    request.conversationId,
    request.items,
    newConversationRecord(context, {
      id: request.conversationId,
      site: request.site,
      status: request.status,
    }),
  );
  if (result.dateOffsetDays === null) throw new VaultError('no-conversation');
  return { ...result, dateOffsetDays: result.dateOffsetDays };
}

/** prepareMask without writing anything (while the user types). */
export function peekMask(
  context: VaultContext,
  conversationId: string,
  items: readonly RealValue[],
): Promise<PrepareResult> {
  return lookUp(context, conversationId, items, null);
}

export interface CommitEntry {
  real: RealValue;
  /** The stand-in exactly as it will be sent. */
  standIn: string;
  /** Its normal form under the real value's rules. */
  standInNormalised: string;
  /** Stand-in-side forms (a PERSON stand-in's name parts). */
  variants?: readonly string[];
  /** The word-list locale the stand-in came from. */
  locale?: string | null;
  /** The stand-in of the mapping this one belongs to (an email's person). */
  parent?: string | null;
}

export type CommittedValue =
  /** Stored now: send this stand-in. */
  | { kind: 'inserted'; standIn: string }
  /** Already stored by another tab: send this stand-in. */
  | { kind: 'existing'; standIn: string; variants: string[] }
  /** Used for another value or equal to a real value: try another. */
  | { kind: 'taken' };

export interface CommitResult {
  /** One per entry, in order. */
  values: CommittedValue[];
  /** Mappings this request stored. */
  inserted: number;
  /**
   * Reused values that are no longer stored (deleted since they were looked
   * up): the stand-ins the caller holds for them are stale.
   */
  missing: number;
}

interface PreparedEntry {
  mapping: Mapping;
  /** realHash of the stand-in read as a real value (TR-S3). */
  standInHash: string;
}

/**
 * Stores each entry and counts the reuse of each `reused` value, in one
 * transaction. The conversation must exist (prepareMask made it).
 */
export async function commitMask(
  context: VaultContext,
  conversationId: string,
  entries: readonly CommitEntry[],
  reused: readonly RealValue[] = [],
): Promise<CommitResult> {
  const now = context.now();
  const parents = entries.map((entry) =>
    entry.parent === undefined || entry.parent === null
      ? null
      : normaliseStandIn(entry.parent),
  );
  const prepared: PreparedEntry[] = await Promise.all(
    entries.map(async (entry) => {
      const { real } = entry;
      const id = context.crypto.randomUUID();
      const [realHash, standInHash, realEnc] = await Promise.all([
        hashOf(context, conversationId, real),
        hashOf(context, conversationId, {
          ...real,
          normalised: entry.standInNormalised,
        }),
        encryptReal(
          context.crypto,
          context.keys.enc,
          { value: real.value, normalised: real.normalised },
          mappingBinding({
            id,
            conversationId,
            type: real.type,
            subtype: real.subtype,
          }),
        ),
      ]);
      const mapping: Mapping = {
        id,
        conversationId,
        type: real.type,
        subtype: real.subtype,
        country: real.country,
        locale: entry.locale ?? null,
        realHash,
        realEnc,
        surrogate: entry.standIn,
        surrogateNorm: normaliseStandIn(entry.standIn),
        variants: [...(entry.variants ?? [])],
        parentId: null,
        source: 'rule',
        confidence: 1,
        createdAt: now,
        hitCount: 0,
      };
      return { mapping, standInHash };
    }),
  );
  const reusedHashes = await Promise.all(
    reused.map((real) => hashOf(context, conversationId, real)),
  );

  return withTransaction(
    context.db,
    [STORE.conversations, STORE.mappings],
    'readwrite',
    async (transaction) => {
      const conversations = transaction.objectStore(STORE.conversations);
      const conversation = conversationOf(
        await requestResult(conversations.get(conversationId)),
      );
      if (conversation === null) throw new VaultError('no-conversation');
      const mappings = transaction.objectStore(STORE.mappings);
      const byRealHash = mappings.index(INDEX.mappingsByConvRealHash);
      const bySurrogate = mappings.index(INDEX.mappingsByConvSurrogate);

      /** Counts a reuse of a stored mapping; false if it is not stored. */
      const reuse = async (hash: string): Promise<Mapping | null> => {
        const stored = mappingOf(
          await requestResult(byRealHash.get([conversationId, hash])),
        );
        if (stored !== null) {
          await requestResult(
            mappings.put({ ...stored, hitCount: stored.hitCount + 1 }),
          );
        }
        return stored;
      };

      const values: CommittedValue[] = [];
      let inserted = 0;
      for (const [position, { mapping, standInHash }] of prepared.entries()) {
        // Stored meanwhile (another tab, or earlier in this request).
        const existing = await reuse(mapping.realHash);
        if (existing !== null) {
          values.push({
            kind: 'existing',
            standIn: existing.surrogate,
            variants: [...existing.variants],
          });
          continue;
        }
        const usedForAnother = await requestResult(
          bySurrogate.count([conversationId, mapping.surrogateNorm]),
        );
        const equalsRealValue = await requestResult(
          byRealHash.count([conversationId, standInHash]),
        );
        if (usedForAnother > 0 || equalsRealValue > 0) {
          values.push({ kind: 'taken' });
          continue;
        }
        // The parent is stored by now (persons are issued before their
        // emails); a parent deleted meanwhile leaves no link.
        const parent = parents[position] ?? null;
        const parentRecord =
          parent === null
            ? null
            : mappingOf(
                await requestResult(bySurrogate.get([conversationId, parent])),
              );
        await requestResult(
          mappings.add({ ...mapping, parentId: parentRecord?.id ?? null }),
        );
        inserted += 1;
        values.push({ kind: 'inserted', standIn: mapping.surrogate });
      }
      let missing = 0;
      for (const hash of reusedHashes) {
        if ((await reuse(hash)) === null) missing += 1;
      }
      await requestResult(
        conversations.put({
          ...conversation,
          lastUsedAt: now,
          mappingCount: conversation.mappingCount + inserted,
        }),
      );
      return { values, inserted, missing };
    },
  );
}
