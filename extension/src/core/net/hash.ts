import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';

/** Kinds of value with a normal form of their own here (stand-in emails). */
export type ValueKind = 'email';

/** A 32-byte key as 64 lowercase hex characters. */
export const HASH_KEY_PATTERN = /^[0-9a-f]{64}$/;

const NORMALISERS: Record<ValueKind, (value: string) => string> = {
  // Addresses compare case-insensitively in practice.
  email: (value) => value.trim().toLowerCase(),
};

/** The canonical form compared by the safety net. */
export function normaliseValue(kind: ValueKind, value: string): string {
  return NORMALISERS[kind](value);
}

export function hmacSha256Hex(
  keyHex: string,
  message: string | Uint8Array,
): string {
  const data = typeof message === 'string' ? utf8ToBytes(message) : message;
  return bytesToHex(hmac(sha256, hexToBytes(keyHex), data));
}

/** Keyed hash of a compact form (see compact.ts). */
export type FormHasher = (form: string) => string;

/**
 * Keyed hash of a value's compact form. The page's world only ever holds
 * these hashes of real values, never the values themselves.
 */
export function createFormHasher(keyHex: string): FormHasher {
  if (!HASH_KEY_PATTERN.test(keyHex)) {
    throw new RangeError('hash key must be 32 bytes of lowercase hex');
  }
  return (form) => hmacSha256Hex(keyHex, `form\u0000${form}`);
}

/** A fresh random key from the given random source. */
export function randomHashKey(
  fillRandom: (bytes: Uint8Array) => Uint8Array,
): string {
  return bytesToHex(fillRandom(new Uint8Array(32)));
}
