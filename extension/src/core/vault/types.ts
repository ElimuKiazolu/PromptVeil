/** Vault record types besides Mapping (src/shared/entities.ts). */
import type { SiteId } from '@/src/shared/settings.ts';

export type KeyId = 'enc' | 'lookup' | 'seed';

export const KEY_IDS: readonly KeyId[] = ['enc', 'lookup', 'seed'];

/** A `keys` record: the CryptoKey is stored by structured clone. */
export interface KeyRecord {
  id: KeyId;
  key: CryptoKey;
  createdAt: number;
}

/** enc = AES-GCM 256; lookup and seed = HMAC-SHA-256; all non-extractable. */
export interface VaultKeys {
  enc: CryptoKey;
  lookup: CryptoKey;
  seed: CryptoKey;
}

export type ConversationStatus = 'active' | 'pending';

export interface ConversationRecord {
  /** `{site}:{conversationId}` or `{site}:pending:{uuid}`. */
  id: string;
  site: SiteId;
  status: ConversationStatus;
  /** Whole days, ±30–365, never 0 (DOB/DATE stand-ins). */
  dateOffsetDays: number;
  createdAt: number;
  lastUsedAt: number;
  mappingCount: number;
}
