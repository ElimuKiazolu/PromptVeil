/**
 * Deterministic random numbers for stand-in generation (TR-S1).
 *
 * The 32-byte seed comes from the vault (HMAC of the conversation, type and
 * normal form under the seed key), so the same value in the same
 * conversation always draws the same numbers, and nothing about the value
 * can be learnt from them without the key. Bytes are SHA-256 in counter
 * mode: block i = SHA-256(tag, seed, stream, i), each part length-prefixed.
 * A stream name separates independent draws from one seed (one per
 * attempt, plus one that every attempt shares).
 *
 * Integers are drawn by rejection sampling, so every value in a range is
 * equally likely (no modulo bias).
 */
import { sha256 } from '@noble/hashes/sha2.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';

const TAG = utf8ToBytes('pv-prng/1');
export const SEED_LENGTH = 32;
const UINT32_RANGE = 2 ** 32;

export const DIGITS = '0123456789';
export const UPPER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
export const LOWER = 'abcdefghijklmnopqrstuvwxyz';

export interface Rng {
  /** A uniform integer in [0, n), for 1 ≤ n ≤ 2^32. */
  int(n: number): number;
  /** A uniform integer in [min, max]. */
  between(min: number, max: number): number;
  /** One character of the alphabet, uniformly. */
  char(alphabet: string): string;
  /** `count` characters of the alphabet. */
  chars(alphabet: string, count: number): string;
  pick<T>(items: readonly T[]): T;
}

function lengthPrefixed(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + 4 + part.length, 0);
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  let offset = 0;
  for (const part of parts) {
    view.setUint32(offset, part.length);
    out.set(part, offset + 4);
    offset += 4 + part.length;
  }
  return out;
}

export function createRng(seed: Uint8Array, stream: string): Rng {
  if (seed.length !== SEED_LENGTH) throw new RangeError('seed length');
  const streamBytes = utf8ToBytes(stream);
  let block = new Uint8Array(0);
  let position = 0;
  let counter = 0;

  const nextBlock = (): void => {
    const index = new Uint8Array(4);
    new DataView(index.buffer).setUint32(0, counter);
    counter += 1;
    block = sha256(lengthPrefixed([TAG, seed, streamBytes, index]));
    position = 0;
  };

  const uint32 = (): number => {
    let value = 0;
    for (let i = 0; i < 4; i += 1) {
      if (position >= block.length) nextBlock();
      value = value * 256 + (block[position] ?? 0);
      position += 1;
    }
    return value;
  };

  const int = (n: number): number => {
    if (!Number.isInteger(n) || n < 1 || n > UINT32_RANGE) {
      throw new RangeError('range');
    }
    // Draws at or above the largest multiple of n are rejected.
    const limit = UINT32_RANGE - (UINT32_RANGE % n);
    for (;;) {
      const value = uint32();
      if (value < limit) return value % n;
    }
  };

  const char = (alphabet: string): string =>
    alphabet.charAt(int(alphabet.length));

  return {
    int,
    between: (min, max) => min + int(max - min + 1),
    char,
    chars: (alphabet, count) => {
      let out = '';
      for (let i = 0; i < count; i += 1) out += char(alphabet);
      return out;
    },
    pick<T>(items: readonly T[]): T {
      const item = items[int(items.length)];
      if (item === undefined) throw new RangeError('empty list');
      return item;
    },
  };
}
