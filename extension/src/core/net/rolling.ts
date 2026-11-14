/**
 * Keyed rolling hash: the request safety net's cheap pre-check. Every window
 * of a request's compact text whose rolling value matches a masked value's
 * is then confirmed with the full keyed hash (HMAC-SHA-256), so a pre-check
 * collision never blocks on its own.
 *
 * Polynomial hash modulo the Mersenne prime 2^31 − 1 with a secret base drawn
 * from the channel key: without the key, a rolling value tells nothing about
 * the value it came from. Every product stays below 2^53, so plain number
 * arithmetic is exact.
 */
import { hexToBytes } from '@noble/hashes/utils.js';
import { hmacSha256Hex } from './hash.ts';

const MODULUS = 2_147_483_647;
const BASE_MIN = 2 ** 20;
const BASE_SPAN = 3 * 2 ** 20;

export interface RollingHash {
  /** The rolling value of a whole string. */
  of(text: string): number;
  /**
   * Calls `hit(start)` for every window of `length` characters of `text`
   * whose rolling value is in `values`.
   */
  scan(
    text: string,
    length: number,
    values: ReadonlySet<number>,
    hit: (start: number) => boolean,
  ): boolean;
}

/** The secret base for a channel key (64 hex characters). */
export function rollingBase(keyHex: string): number {
  const bytes = hexToBytes(hmacSha256Hex(keyHex, 'pv-roll/1').slice(0, 8));
  const value =
    ((bytes[0] ?? 0) * 2 ** 24 +
      (bytes[1] ?? 0) * 2 ** 16 +
      (bytes[2] ?? 0) * 2 ** 8 +
      (bytes[3] ?? 0)) %
    BASE_SPAN;
  return BASE_MIN + value;
}

export function createRollingHash(base: number): RollingHash {
  const of = (text: string): number => {
    let hash = 0;
    for (let i = 0; i < text.length; i += 1) {
      hash = (hash * base + text.charCodeAt(i)) % MODULUS;
    }
    return hash;
  };

  /** base^(length − 1) mod MODULUS, the weight of a window's first character. */
  const lead = (length: number): number => {
    let power = 1;
    for (let i = 1; i < length; i += 1) power = (power * base) % MODULUS;
    return power;
  };

  return {
    of,
    scan(text, length, values, hit) {
      if (length <= 0 || text.length < length) return false;
      const weight = lead(length);
      let hash = of(text.slice(0, length));
      for (let start = 0; ; start += 1) {
        if (values.has(hash) && hit(start)) return true;
        const end = start + length;
        if (end >= text.length) return false;
        const removed = (text.charCodeAt(start) * weight) % MODULUS;
        hash = (hash - removed + MODULUS) % MODULUS;
        hash = (hash * base + text.charCodeAt(end)) % MODULUS;
      }
    },
  };
}
