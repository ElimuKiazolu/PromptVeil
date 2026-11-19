/**
 * CRYPTO stand-ins (TR-S2): the same chain and format with a random payload
 * and a valid checksum. A random 160- or 256-bit payload is no one's key
 * (finding its owner would mean breaking the hash), so nothing sent to a
 * stand-in reaches a person.
 *
 * - Base58Check: the same version byte, the same length where possible
 *   (most payloads give it; a few lengths differ by one).
 * - SegWit: the same prefix, witness version and program length, in the
 *   same case; bech32 for version 0, bech32m above.
 * - Ethereum: the same "0x"/"0X" and the same casing style (lower, upper,
 *   or EIP-55 checksum casing).
 */
import { base58, bech32, bech32m } from '@scure/base';
import {
  base58Checksum,
  eip55,
  parseCryptoAddress,
  type CryptoAddress,
} from '../detect/validators/crypto.ts';
import type { Rng } from './rng.ts';
import type { Generator } from './types.ts';

/** Payloads tried for a Base58 address of the real one's length. */
const LENGTH_DRAWS = 32;

function bytes(rng: Rng, count: number): Uint8Array {
  const out = new Uint8Array(count);
  for (let i = 0; i < count; i += 1) out[i] = rng.int(256);
  return out;
}

function base58Address(rng: Rng, version: number, length: number): string {
  let first = '';
  for (let draw = 0; draw < LENGTH_DRAWS; draw += 1) {
    const payload = new Uint8Array(21);
    payload[0] = version;
    payload.set(bytes(rng, 20), 1);
    const full = new Uint8Array(25);
    full.set(payload);
    full.set(base58Checksum(payload), 21);
    const text = base58.encode(full);
    if (text.length === length) return text;
    first ||= text;
  }
  return first;
}

function addressLike(rng: Rng, real: string, format: CryptoAddress): string {
  switch (format.kind) {
    case 'base58':
      return base58Address(rng, format.version, real.length);
    case 'segwit': {
      const coder = format.witnessVersion === 0 ? bech32 : bech32m;
      const words = [
        format.witnessVersion,
        ...coder.toWords(bytes(rng, format.programLength)),
      ];
      const text = coder.encode(format.prefix, words, 90);
      return format.upper ? text.toUpperCase() : text;
    }
    case 'ethereum': {
      const hex = Array.from(bytes(rng, 20), (byte) =>
        byte.toString(16).padStart(2, '0'),
      ).join('');
      const cased =
        format.casing === 'upper'
          ? hex.toUpperCase()
          : format.casing === 'checksum'
            ? eip55(hex)
            : hex;
      return format.prefix + cased;
    }
  }
}

export const cryptoStandIn: Generator = ({ request, rng }) => {
  const format = parseCryptoAddress(request.value);
  if (format === null) return null;
  return { value: addressLike(rng, request.value, format), reserved: false };
};

/** The same chain, format and case style, with a valid checksum. */
export function isWellFormedCryptoStandIn(
  standIn: string,
  real: string,
): boolean {
  const a = parseCryptoAddress(standIn);
  const b = parseCryptoAddress(real);
  if (a === null || b === null) return false;
  switch (a.kind) {
    case 'base58':
      return b.kind === 'base58' && a.version === b.version;
    case 'segwit':
      return (
        b.kind === 'segwit' &&
        a.prefix === b.prefix &&
        a.witnessVersion === b.witnessVersion &&
        a.programLength === b.programLength &&
        a.upper === b.upper
      );
    case 'ethereum':
      return (
        b.kind === 'ethereum' && a.casing === b.casing && a.prefix === b.prefix
      );
  }
}
