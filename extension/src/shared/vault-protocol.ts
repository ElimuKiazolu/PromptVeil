/**
 * Messages between content scripts and the service worker, which owns the
 * vault. Requests go to the service worker only (no other context registers
 * a runtime message listener); real values travel in `vault.prepare` and
 * `vault.commit` requests and back in the `vault.load` reply to the tab that
 * asked, never in notices.
 *
 * Masking takes two requests: `vault.prepare` returns each value's stored
 * stand-in or its seed; the content script generates stand-ins with the
 * detection module (which has the phone library) and checks them against
 * the prompt; `vault.commit` stores them, or reports one as taken (the
 * content script then tries its next attempt).
 *
 * The background checks every conversation ID against the sending tab (see
 * src/background/sender.ts); the shapes here are checked on both sides.
 */
import type { VaultErrorCode } from '../core/vault/errors.ts';
import { isCountryCode, type CountryCode } from './country.ts';
import {
  isEntitySubtype,
  isEntityType,
  type EntitySubtype,
  type EntityType,
} from './entities.ts';
import type { ProtocolSpec } from './messaging.ts';

/** Items per `vault.prepare` or `vault.commit` request; more are split into batches. */
export const MAX_MASK_ITEMS = 200;

/** Longest value (and normal form) a request may carry. */
export const MAX_VALUE_LENGTH = 4096;

/** Most variants per mapping, and the longest locale id. */
export const MAX_VARIANTS = 16;
const LOCALE_ID = /^[a-z]{2}(?:_[A-Z]{2})?$/u;

/** Longest conversation ID accepted in a message. */
const MAX_CONVERSATION_ID_LENGTH = 256;

/** One detected value to mask. */
export interface MaskItem {
  type: EntityType;
  subtype: EntitySubtype | null;
  country: CountryCode | null;
  value: string;
  /** Vault normal form, computed by the detection module. */
  normalised: string;
}

/** Why a vault request did not succeed. */
export type VaultFailure =
  { status: 'keys-lost' } | { status: 'error'; code: VaultFailureCode };

/** A vault error, or `forbidden` when the sender may not use the conversation. */
export type VaultFailureCode = VaultErrorCode | 'forbidden';

export interface PrepareRequest {
  conversationId: string;
  items: MaskItem[];
}

export type PreparedItem =
  | { kind: 'existing'; standIn: string }
  /** A value new to the conversation: its seed (base64, 32 bytes) and number. */
  | { kind: 'new'; seed: string; number: number };

export type PrepareResponse =
  | { status: 'ok'; dateOffsetDays: number; items: PreparedItem[] }
  | VaultFailure;

/** Like vault.prepare, but nothing is written (while the user types). */
export type PeekResponse =
  | {
      status: 'ok';
      /** Null while the conversation does not exist yet. */
      dateOffsetDays: number | null;
      items: PreparedItem[];
    }
  | VaultFailure;

export interface CommitEntry {
  item: MaskItem;
  standIn: string;
  /** The stand-in's normal form under the real value's rules. */
  standInNormalised: string;
  /** Stand-in-side forms stored with it (a PERSON stand-in's name parts). */
  variants: string[];
  /** The word-list locale the stand-in came from. */
  locale: string | null;
  /** The stand-in of the mapping this one belongs to (an email's person). */
  parent: string | null;
}

export interface CommitRequest {
  conversationId: string;
  /** New stand-ins to store. */
  entries: CommitEntry[];
  /** Stored values sent again: their reuse is counted. */
  reused: MaskItem[];
}

export type CommittedItem =
  { kind: 'inserted' | 'existing'; standIn: string } | { kind: 'taken' };

export type CommitResponse =
  | {
      status: 'ok';
      items: CommittedItem[];
      /** Reused values no longer stored (deleted since they were looked up). */
      missing: number;
    }
  | VaultFailure;

export interface LoadRequest {
  conversationId: string;
}

/** A stored stand-in with its real value (reply to the requesting tab only). */
export interface LoadedMapping {
  standIn: string;
  real: string;
  /** The real value's normal form (the request safety net needs it). */
  normalised: string;
  type: EntityType;
  /** Stand-in-side forms (a PERSON stand-in's name parts). */
  variants: string[];
  locale: string | null;
  /** The stand-in of the mapping this one belongs to. */
  parent: string | null;
}

export type LoadResponse =
  { status: 'ok'; mappings: LoadedMapping[]; failed: number } | VaultFailure;

export interface MigrateRequest {
  /** The tab's pending ID. */
  from: string;
  /** The conversation ID the site assigned. */
  to: string;
}

export type MigrateResponse =
  { status: 'migrated'; count: number } | { status: 'nothing' } | VaultFailure;

export interface VaultProtocol {
  'vault.prepare': { request: PrepareRequest; response: PrepareResponse };
  'vault.peek': { request: PrepareRequest; response: PeekResponse };
  'vault.commit': { request: CommitRequest; response: CommitResponse };
  'vault.load': { request: LoadRequest; response: LoadResponse };
  'vault.migrate': { request: MigrateRequest; response: MigrateResponse };
}

/** Service worker → tabs. Carry conversation IDs only. */
export type VaultNotice =
  /** A conversation gained mappings (another tab masked or migrated into it). */
  | { name: 'vault.changed'; conversationId: string }
  /** Mappings were deleted (auto-delete, or 'all' for delete-all). */
  | { name: 'vault.dropped'; conversationIds: string[] | 'all' };

type Fields = Record<string, unknown>;

function isObject(value: unknown): value is Fields {
  return typeof value === 'object' && value !== null;
}

function isBoundedString(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}

function isConversationIdText(value: unknown): value is string {
  return isBoundedString(value, MAX_CONVERSATION_ID_LENGTH);
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** Every failure code; the type makes the list complete. */
const FAILURE_CODES: Record<VaultFailureCode, true> = {
  unavailable: true,
  blocked: true,
  'version-too-new': true,
  'upgrade-failed': true,
  'keys-lost': true,
  'decrypt-failed': true,
  'corrupt-record': true,
  constraint: true,
  'no-conversation': true,
  quota: true,
  aborted: true,
  closed: true,
  forbidden: true,
};

function isFailure(value: Fields): boolean {
  if (value.status === 'keys-lost') return true;
  return (
    value.status === 'error' &&
    typeof value.code === 'string' &&
    Object.hasOwn(FAILURE_CODES, value.code)
  );
}

export function isMaskItem(value: unknown): value is MaskItem {
  return (
    isObject(value) &&
    isEntityType(value.type) &&
    (value.subtype === null || isEntitySubtype(value.subtype)) &&
    (value.country === null ||
      (typeof value.country === 'string' && isCountryCode(value.country))) &&
    isBoundedString(value.value, MAX_VALUE_LENGTH) &&
    isBoundedString(value.normalised, MAX_VALUE_LENGTH)
  );
}

function isBatch(value: unknown): value is unknown[] {
  return (
    Array.isArray(value) && value.length > 0 && value.length <= MAX_MASK_ITEMS
  );
}

function isPrepareRequest(value: unknown): value is PrepareRequest {
  return (
    isObject(value) &&
    isConversationIdText(value.conversationId) &&
    isBatch(value.items) &&
    value.items.every(isMaskItem)
  );
}

/** Standard base64 of 32 bytes. */
const SEED = /^[A-Za-z0-9+/]{43}=$/u;

function isPreparedItem(value: unknown): value is PreparedItem {
  if (!isObject(value)) return false;
  if (value.kind === 'existing') {
    return isBoundedString(value.standIn, MAX_VALUE_LENGTH);
  }
  return (
    value.kind === 'new' &&
    typeof value.seed === 'string' &&
    SEED.test(value.seed) &&
    isCount(value.number) &&
    value.number > 0
  );
}

function isOffset(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

function isPrepareResponse(value: unknown): value is PrepareResponse {
  if (!isObject(value)) return false;
  if (value.status === 'ok') {
    return (
      isOffset(value.dateOffsetDays) &&
      Array.isArray(value.items) &&
      value.items.every(isPreparedItem)
    );
  }
  return isFailure(value);
}

function isPeekResponse(value: unknown): value is PeekResponse {
  if (!isObject(value)) return false;
  if (value.status === 'ok') {
    return (
      (value.dateOffsetDays === null || isOffset(value.dateOffsetDays)) &&
      Array.isArray(value.items) &&
      value.items.every(isPreparedItem)
    );
  }
  return isFailure(value);
}

function isVariants(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= MAX_VARIANTS &&
    value.every((variant) => isBoundedString(variant, MAX_VALUE_LENGTH))
  );
}

function isLocale(value: unknown): value is string | null {
  return value === null || (typeof value === 'string' && LOCALE_ID.test(value));
}

function isParent(value: unknown): value is string | null {
  return value === null || isBoundedString(value, MAX_VALUE_LENGTH);
}

function isCommitEntry(value: unknown): value is CommitEntry {
  return (
    isObject(value) &&
    isMaskItem(value.item) &&
    isBoundedString(value.standIn, MAX_VALUE_LENGTH) &&
    isBoundedString(value.standInNormalised, MAX_VALUE_LENGTH) &&
    isVariants(value.variants) &&
    isLocale(value.locale) &&
    isParent(value.parent)
  );
}

function isCommitRequest(value: unknown): value is CommitRequest {
  if (
    !isObject(value) ||
    !isConversationIdText(value.conversationId) ||
    !Array.isArray(value.entries) ||
    !Array.isArray(value.reused)
  ) {
    return false;
  }
  const total = value.entries.length + value.reused.length;
  return (
    total > 0 &&
    total <= MAX_MASK_ITEMS &&
    value.entries.every(isCommitEntry) &&
    value.reused.every(isMaskItem)
  );
}

function isCommittedItem(value: unknown): value is CommittedItem {
  if (!isObject(value)) return false;
  if (value.kind === 'taken') return true;
  return (
    (value.kind === 'inserted' || value.kind === 'existing') &&
    isBoundedString(value.standIn, MAX_VALUE_LENGTH)
  );
}

function isCommitResponse(value: unknown): value is CommitResponse {
  if (!isObject(value)) return false;
  if (value.status === 'ok') {
    return (
      Array.isArray(value.items) &&
      value.items.every(isCommittedItem) &&
      isCount(value.missing)
    );
  }
  return isFailure(value);
}

function isLoadRequest(value: unknown): value is LoadRequest {
  return isObject(value) && isConversationIdText(value.conversationId);
}

function isLoadedMapping(value: unknown): value is LoadedMapping {
  return (
    isObject(value) &&
    isBoundedString(value.standIn, MAX_VALUE_LENGTH) &&
    typeof value.real === 'string' &&
    typeof value.normalised === 'string' &&
    isEntityType(value.type) &&
    isVariants(value.variants) &&
    isLocale(value.locale) &&
    isParent(value.parent)
  );
}

function isLoadResponse(value: unknown): value is LoadResponse {
  if (!isObject(value)) return false;
  if (value.status === 'ok') {
    return (
      Array.isArray(value.mappings) &&
      value.mappings.every(isLoadedMapping) &&
      isCount(value.failed)
    );
  }
  return isFailure(value);
}

function isMigrateRequest(value: unknown): value is MigrateRequest {
  return (
    isObject(value) &&
    isConversationIdText(value.from) &&
    isConversationIdText(value.to)
  );
}

function isMigrateResponse(value: unknown): value is MigrateResponse {
  if (!isObject(value)) return false;
  if (value.status === 'migrated') return isCount(value.count);
  if (value.status === 'nothing') return true;
  return isFailure(value);
}

export const VAULT_PROTOCOL: ProtocolSpec<VaultProtocol> = {
  'vault.prepare': { request: isPrepareRequest, response: isPrepareResponse },
  'vault.peek': { request: isPrepareRequest, response: isPeekResponse },
  'vault.commit': { request: isCommitRequest, response: isCommitResponse },
  'vault.load': { request: isLoadRequest, response: isLoadResponse },
  'vault.migrate': { request: isMigrateRequest, response: isMigrateResponse },
};

export function isVaultNotice(value: unknown): value is VaultNotice {
  if (!isObject(value)) return false;
  if (value.name === 'vault.changed') {
    return isConversationIdText(value.conversationId);
  }
  return (
    value.name === 'vault.dropped' &&
    (value.conversationIds === 'all' ||
      (Array.isArray(value.conversationIds) &&
        value.conversationIds.every(isConversationIdText)))
  );
}
