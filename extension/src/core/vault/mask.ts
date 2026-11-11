/**
 * Masking against the vault, in two steps, so stand-ins can be generated
 * where the phone library and the prompt are (the content script, through
 * the detection module) while the keys and records stay here:
 *
 * 1. prepareMask: each value's stored stand-in, or (new value) its seed,
 *    HMAC(seed key, conversation, type, normal form) (TR-S1), and the
 *    mapping number; plus the conversation's date offset.
 * 2. commitMask: stores each generated stand-in with its real value, unless
 *    the stand-in is taken: used for another value, or equal to a real value
 *    of the conversation (by hash). The caller then tries its next attempt.
 *
 * Every tab and every later page load sends the same stand-in for the same
 * value in a conversation, because the first one stored wins.
 */
import type { SiteId } from '@/src/shared/settings.ts';
import { seedFor } from './crypto.ts';
import {
  createConversation,
  findByReal,
  insertMapping,
  type RealValue,
  type VaultContext,
} from './mappings.ts';
import type { ConversationStatus } from './types.ts';

export interface PrepareRequest {
  conversationId: string;
  site: SiteId;
  /** Status of the conversation if it has to be created. */
  status: ConversationStatus;
  items: readonly RealValue[];
}

export type PreparedValue =
  | { kind: 'existing'; standIn: string }
  | {
      kind: 'new';
      /** 32 bytes; the stand-in engine's seed for this value. */
      seed: Uint8Array;
      /** The mapping's number if stored now (1 for the first). */
      number: number;
    };

export interface PrepareResult {
  dateOffsetDays: number;
  /** One per item, in order. */
  values: PreparedValue[];
}

/**
 * Creates the conversation if needed and looks every item up. A stored
 * value counts as a reuse. Values new to the conversation are numbered in
 * order after its stored mappings.
 */
export async function prepareMask(
  context: VaultContext,
  request: PrepareRequest,
): Promise<PrepareResult> {
  const conversation = await createConversation(context, {
    id: request.conversationId,
    site: request.site,
    status: request.status,
  });
  const values: PreparedValue[] = [];
  let fresh = 0;
  for (const real of request.items) {
    const found = await findByReal(context, request.conversationId, real);
    if (found !== null) {
      values.push({ kind: 'existing', standIn: found.surrogate });
      continue;
    }
    fresh += 1;
    values.push({
      kind: 'new',
      seed: await seedFor(context.crypto, context.keys.seed, {
        conversationId: request.conversationId,
        type: real.type,
        normalised: real.normalised,
      }),
      number: conversation.mappingCount + fresh,
    });
  }
  return { dateOffsetDays: conversation.dateOffsetDays, values };
}

export interface CommitEntry {
  real: RealValue;
  /** The stand-in exactly as it will be sent. */
  standIn: string;
  /** Its normal form under the real value's rules. */
  standInNormalised: string;
}

export type CommittedValue =
  /** Stored now, or already stored by another tab: send this stand-in. */
  | { kind: 'inserted' | 'existing'; standIn: string }
  /** Used for another value or equal to a real value: try another. */
  | { kind: 'taken' };

export interface CommitResult {
  /** One per entry, in order. */
  values: CommittedValue[];
  /** Mappings this request stored. */
  inserted: number;
}

/** Stores each entry (the conversation must exist; prepareMask made it). */
export async function commitMask(
  context: VaultContext,
  conversationId: string,
  entries: readonly CommitEntry[],
): Promise<CommitResult> {
  const values: CommittedValue[] = [];
  let inserted = 0;
  for (const entry of entries) {
    const result = await insertMapping(context, {
      conversationId,
      real: entry.real,
      surrogate: entry.standIn,
      surrogateNormalised: entry.standInNormalised,
      variants: [],
      locale: null,
      parentId: null,
      source: 'rule',
      confidence: 1,
    });
    switch (result.status) {
      case 'inserted':
        inserted += 1;
        values.push({ kind: 'inserted', standIn: result.mapping.surrogate });
        break;
      case 'existing':
        values.push({ kind: 'existing', standIn: result.mapping.surrogate });
        break;
      case 'surrogate-taken':
        values.push({ kind: 'taken' });
        break;
    }
  }
  return { values, inserted };
}
