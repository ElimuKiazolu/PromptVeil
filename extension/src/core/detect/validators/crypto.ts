/**
 * Cryptocurrency addresses (TR §4.2, P1): parsing with checksums, and the
 * normal form.
 *
 * - Bitcoin legacy (Base58Check): version byte 0x00 (P2PKH, "1…") or 0x05
 *   (P2SH, "3…"), testnet 0x6f / 0xc4 ("m…", "n…", "2…"); 20-byte hash; the
 *   4-byte double SHA-256 checksum must match.
 * - Bitcoin SegWit (BIP-173 bech32 for witness version 0, BIP-350 bech32m
 *   for versions 1–16): prefix "bc" or "tb"; v0 programs of 20 or 32 bytes,
 *   others 2–40 bytes; one case only.
 * - Ethereum: "0x" and 40 hex digits. Mixed case must be the EIP-55
 *   checksum casing; all lower or all upper case carries no checksum.
 *
 * Decoding uses @scure/base (base58, bech32, bech32m) and @noble/hashes
 * (SHA-256, Keccak-256); invalid input gives null, never an exception.
 */
import { keccak_256 } from '@noble/hashes/sha3.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import { base58, bech32, bech32m } from '@scure/base';

export type Base58Version = 0x00 | 0x05 | 0x6f | 0xc4;
export type SegwitPrefix = 'bc' | 'tb';
export type EthereumCasing = 'lower' | 'upper' | 'checksum';

export type CryptoAddress =
  | { readonly kind: 'base58'; readonly version: Base58Version }
  | {
      readonly kind: 'segwit';
      readonly prefix: SegwitPrefix;
      readonly witnessVersion: number;
      readonly programLength: number;
      readonly upper: boolean;
    }
  | {
      readonly kind: 'ethereum';
      readonly casing: EthereumCasing;
      /** "0x" or "0X", as written. */
      readonly prefix: string;
    };

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{25,35}$/u;
const VERSIONS: readonly Base58Version[] = [0x00, 0x05, 0x6f, 0xc4];
const ETHEREUM = /^0[xX][0-9A-Fa-f]{40}$/u;

/** The first four bytes of SHA-256(SHA-256(payload)). */
export function base58Checksum(payload: Uint8Array): Uint8Array {
  return sha256(sha256(payload)).slice(0, 4);
}

function parseBase58(value: string): CryptoAddress | null {
  if (!BASE58.test(value)) return null;
  const bytes = base58.decode(value);
  if (bytes.length !== 25) return null;
  const version = bytes[0];
  const check = base58Checksum(bytes.slice(0, 21));
  if (!check.every((byte, i) => byte === bytes[21 + i])) return null;
  const known = VERSIONS.find((entry) => entry === version);
  return known === undefined ? null : { kind: 'base58', version: known };
}

function parseSegwit(value: string): CryptoAddress | null {
  const lower = value.toLowerCase();
  const upper = value === value.toUpperCase();
  if (value !== lower && !upper) return null;
  const prefix = lower.slice(0, 2);
  if ((prefix !== 'bc' && prefix !== 'tb') || lower.charAt(2) !== '1') {
    return null;
  }
  const decoded =
    bech32.decodeUnsafe(lower, 90) ?? bech32m.decodeUnsafe(lower, 90);
  if (decoded?.prefix !== prefix) return null;
  const [witnessVersion, ...programWords] = decoded.words;
  if (witnessVersion === undefined || witnessVersion > 16) return null;
  // Version 0 must use bech32, every later version bech32m (BIP-350).
  const coder = witnessVersion === 0 ? bech32 : bech32m;
  if (coder.decodeUnsafe(lower, 90) === undefined) return null;
  const program = coder.fromWordsUnsafe(programWords);
  if (program === undefined) return null;
  const length = program.length;
  const fits =
    witnessVersion === 0
      ? length === 20 || length === 32
      : length >= 2 && length <= 40;
  if (!fits) return null;
  return {
    kind: 'segwit',
    prefix,
    witnessVersion,
    programLength: length,
    upper: value !== lower,
  };
}

/** The EIP-55 casing of 40 lower-case hex digits. */
export function eip55(hex: string): string {
  const hash = keccak_256(utf8ToBytes(hex));
  let out = '';
  for (let i = 0; i < hex.length; i += 1) {
    const char = hex.charAt(i);
    const byte = hash[i >> 1] ?? 0;
    const nibble = i % 2 === 0 ? byte >> 4 : byte & 0x0f;
    out += nibble >= 8 ? char.toUpperCase() : char;
  }
  return out;
}

function parseEthereum(value: string): CryptoAddress | null {
  if (!ETHEREUM.test(value)) return null;
  const hex = value.slice(2);
  const prefix = value.slice(0, 2);
  if (hex === hex.toLowerCase()) {
    return { kind: 'ethereum', casing: 'lower', prefix };
  }
  if (hex === hex.toUpperCase()) {
    return { kind: 'ethereum', casing: 'upper', prefix };
  }
  return eip55(hex.toLowerCase()) === hex
    ? { kind: 'ethereum', casing: 'checksum', prefix }
    : null;
}

export function parseCryptoAddress(value: string): CryptoAddress | null {
  if (ETHEREUM.test(value)) return parseEthereum(value);
  if (/^(?:bc|tb)1/iu.test(value)) return parseSegwit(value);
  return parseBase58(value);
}

/**
 * The normal form: Base58 as written (its case is part of the value);
 * SegWit and Ethereum addresses in lower case (their case is not), so every
 * writing of one address shares a mapping.
 */
export function normaliseCrypto(value: string): string {
  const trimmed = value.trim();
  const address = parseCryptoAddress(trimmed);
  return address === null || address.kind === 'base58'
    ? trimmed
    : trimmed.toLowerCase();
}
