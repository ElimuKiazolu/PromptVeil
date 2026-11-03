/**
 * Masking against the vault: each real value gets the stand-in its
 * conversation already uses for it, or a new one that is stored before it is
 * returned, so every tab and every later page load sends the same stand-in
 * for the same value in a conversation.
 */
import type { SiteId } from '@/src/shared/settings.ts';
import { spikeStandIn } from '../spike-standin.ts';
import { VaultError } from './errors.ts';
import {
  createConversation,
  findByReal,
  insertMapping,
  type RealValue,
  type VaultContext,
} from './mappings.ts';
import type { ConversationStatus } from './types.ts';

/** New stand-ins tried for one value before giving up. */
export const MAX_STAND_IN_ATTEMPTS = 20;

const TAG_LENGTH = 4;
const TAG_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

/**
 * Four random lowercase letters or digits. Stand-ins are unique within a
 * conversation by the vault's index; the tag keeps a stand-in pasted from
 * another conversation from matching one issued here.
 */
function randomTag(crypto: Pick<Crypto, 'getRandomValues'>): string {
  const bytes = crypto.getRandomValues(new Uint8Array(TAG_LENGTH));
  let tag = '';
  for (const byte of bytes) {
    tag += TAG_ALPHABET.charAt(byte % TAG_ALPHABET.length);
  }
  return tag;
}

/** Stand-in for the `number`th mapping of a conversation. */
export type StandInGenerator = (number: number) => string;

export interface MaskRequest {
  conversationId: string;
  site: SiteId;
  /** Status of the conversation if it has to be created. */
  status: ConversationStatus;
  items: readonly RealValue[];
}

export interface MaskResult {
  /** One stand-in per item, in order. */
  standIns: string[];
  /** Mappings this request created. */
  inserted: number;
}

/**
 * Finds or creates the stand-in of every item, creating the conversation if
 * needed. Items are handled one at a time, so a value repeated within the
 * request reuses the mapping made for its first occurrence. Any failure
 * rejects the whole request (the send is then blocked); mappings stored
 * before the failure stay and are reused next time.
 */
export async function maskValues(
  context: VaultContext,
  request: MaskRequest,
  generate: StandInGenerator = (number) =>
    spikeStandIn(number, randomTag(context.crypto)),
): Promise<MaskResult> {
  const conversation = await createConversation(context, {
    id: request.conversationId,
    site: request.site,
    status: request.status,
  });
  const standIns: string[] = [];
  let inserted = 0;
  for (const real of request.items) {
    const found = await findByReal(context, request.conversationId, real);
    if (found !== null) {
      standIns.push(found.surrogate);
      continue;
    }
    const outcome = await insertNew(
      context,
      request.conversationId,
      real,
      generate,
      conversation.mappingCount + inserted + 1,
    );
    if (outcome.inserted) inserted += 1;
    standIns.push(outcome.standIn);
  }
  return { standIns, inserted };
}

async function insertNew(
  context: VaultContext,
  conversationId: string,
  real: RealValue,
  generate: StandInGenerator,
  firstNumber: number,
): Promise<{ standIn: string; inserted: boolean }> {
  for (let attempt = 0; attempt < MAX_STAND_IN_ATTEMPTS; attempt += 1) {
    const result = await insertMapping(context, {
      conversationId,
      real,
      surrogate: generate(firstNumber + attempt),
      variants: [],
      locale: null,
      parentId: null,
      source: 'rule',
      confidence: 1,
    });
    switch (result.status) {
      case 'inserted':
        return { standIn: result.mapping.surrogate, inserted: true };
      case 'existing':
        // Another tab stored this value meanwhile; use its stand-in.
        return { standIn: result.mapping.surrogate, inserted: false };
      case 'surrogate-taken':
        continue;
    }
  }
  throw new VaultError('constraint');
}
