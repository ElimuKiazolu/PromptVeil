/**
 * Messages between content scripts and the service worker, which owns the
 * vault. Requests go to the service worker only (no other context registers
 * a runtime message listener); real values travel in `vault.mask` requests
 * and back in the `vault.load` reply to the tab that asked, never in
 * notices.
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

/** Items per `vault.mask` request; a send with more is split into batches. */
export const MAX_MASK_ITEMS = 200;

/** Longest value (and normal form) a request may carry. */
export const MAX_VALUE_LENGTH = 4096;

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

export interface MaskRequest {
  conversationId: string;
  items: MaskItem[];
}

export type MaskResponse = { status: 'ok'; standIns: string[] } | VaultFailure;

export interface LoadRequest {
  conversationId: string;
}

/** A stored stand-in with its real value (reply to the requesting tab only). */
export interface LoadedMapping {
  standIn: string;
  real: string;
  type: EntityType;
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
  'vault.mask': { request: MaskRequest; response: MaskResponse };
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

function isMaskRequest(value: unknown): value is MaskRequest {
  return (
    isObject(value) &&
    isConversationIdText(value.conversationId) &&
    Array.isArray(value.items) &&
    value.items.length > 0 &&
    value.items.length <= MAX_MASK_ITEMS &&
    value.items.every(isMaskItem)
  );
}

function isMaskResponse(value: unknown): value is MaskResponse {
  if (!isObject(value)) return false;
  if (value.status === 'ok') {
    return (
      Array.isArray(value.standIns) &&
      value.standIns.every((standIn) =>
        isBoundedString(standIn, MAX_VALUE_LENGTH),
      )
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
    isEntityType(value.type)
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
  'vault.mask': { request: isMaskRequest, response: isMaskResponse },
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
