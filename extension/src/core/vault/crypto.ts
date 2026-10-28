/**
 * Vault cryptography over an injected Web Crypto implementation.
 *
 * - Real values: AES-GCM 256, a fresh random 96-bit IV per encryption, and
 *   additional authenticated data naming the record (store, record id,
 *   conversation, type, subtype), so a ciphertext only decrypts in the
 *   record it was written for.
 * - realHash: HMAC-SHA-256(lookup, "pv-lookup/1", conversationId, type,
 *   subtype, norm(real)), base64. The conversation is part of the input, so
 *   one value cannot be linked across conversations on disk.
 * - Seed (P5 stand-in generation): HMAC-SHA-256(seed, "pv-seed/1",
 *   conversationId, type, norm(real)), raw 32 bytes.
 * All inputs use the unambiguous field encoding of encoding.ts.
 */
import type {
  EntitySubtype,
  EntityType,
  EncryptedValue,
} from '@/src/shared/entities.ts';
import { encodeFields, toBase64 } from './encoding.ts';
import { VaultError } from './errors.ts';
import type { StoreName } from './schema.ts';

const IV_BYTES = 12;
const AAD_TAG = 'pv-aad/1';
const LOOKUP_TAG = 'pv-lookup/1';
const SEED_TAG = 'pv-seed/1';

/** Identifies the record a ciphertext belongs to. */
export interface RecordBinding {
  store: Extract<StoreName, 'mappings' | 'customTerms'>;
  recordId: string;
  /** null for records outside a conversation (custom terms). */
  conversationId: string | null;
  type: EntityType;
  subtype: EntitySubtype | null;
}

function additionalData(binding: RecordBinding): Uint8Array<ArrayBuffer> {
  return encodeFields([
    AAD_TAG,
    binding.store,
    binding.recordId,
    binding.conversationId,
    binding.type,
    binding.subtype,
  ]);
}

const encoder = new TextEncoder();

export async function encryptValue(
  crypto: Crypto,
  key: CryptoKey,
  value: string,
  binding: RecordBinding,
): Promise<EncryptedValue> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: additionalData(binding) },
    key,
    encoder.encode(value),
  );
  return { iv, ct };
}

/** Rejects with `decrypt-failed` unless key, IV, ciphertext and record all match. */
export async function decryptValue(
  crypto: Crypto,
  key: CryptoKey,
  encrypted: EncryptedValue,
  binding: RecordBinding,
): Promise<string> {
  if (encrypted.iv.length !== IV_BYTES) throw new VaultError('decrypt-failed');
  let plain: ArrayBuffer;
  try {
    plain = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: encrypted.iv,
        additionalData: additionalData(binding),
      },
      key,
      encrypted.ct,
    );
  } catch (error) {
    throw new VaultError('decrypt-failed', { cause: error });
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(plain);
  } catch (error) {
    throw new VaultError('decrypt-failed', { cause: error });
  }
}

export interface RealHashInput {
  conversationId: string;
  type: EntityType;
  subtype: EntitySubtype | null;
  /** The value in its vault normal form (normaliseReal). */
  normalised: string;
}

export async function realHash(
  crypto: Crypto,
  lookupKey: CryptoKey,
  input: RealHashInput,
): Promise<string> {
  const mac = await crypto.subtle.sign(
    'HMAC',
    lookupKey,
    encodeFields([
      LOOKUP_TAG,
      input.conversationId,
      input.type,
      input.subtype,
      input.normalised,
    ]),
  );
  return toBase64(new Uint8Array(mac));
}

export interface SeedInput {
  conversationId: string;
  type: EntityType;
  normalised: string;
}

/** Deterministic 32 bytes for generating a value's stand-in (P5). */
export async function seedFor(
  crypto: Crypto,
  seedKey: CryptoKey,
  input: SeedInput,
): Promise<Uint8Array<ArrayBuffer>> {
  const mac = await crypto.subtle.sign(
    'HMAC',
    seedKey,
    encodeFields([
      SEED_TAG,
      input.conversationId,
      input.type,
      input.normalised,
    ]),
  );
  return new Uint8Array(mac);
}

const OFFSET_MIN_DAYS = 30;
const OFFSET_MAX_DAYS = 365;
const OFFSET_MAGNITUDES = OFFSET_MAX_DAYS - OFFSET_MIN_DAYS + 1;
/** Both signs of every magnitude. */
const OFFSET_VALUES = OFFSET_MAGNITUDES * 2;
/** Largest multiple of OFFSET_VALUES that fits in 2^32; draws at or above it are rejected. */
const OFFSET_LIMIT = Math.floor(2 ** 32 / OFFSET_VALUES) * OFFSET_VALUES;

/**
 * Uniform whole days in −365…−30 or 30…365 (never 0), by rejection sampling
 * so every value is equally likely.
 */
export function randomDateOffsetDays(
  crypto: Pick<Crypto, 'getRandomValues'>,
): number {
  const draw = new Uint32Array(1);
  for (;;) {
    crypto.getRandomValues(draw);
    const value = draw[0] ?? OFFSET_LIMIT;
    if (value >= OFFSET_LIMIT) continue;
    const index = value % OFFSET_VALUES;
    const magnitude = OFFSET_MIN_DAYS + (index % OFFSET_MAGNITUDES);
    return index < OFFSET_MAGNITUDES ? -magnitude : magnitude;
  }
}
