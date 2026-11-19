import { sha256 } from '@noble/hashes/sha2.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import { base58 } from '@scure/base';
import { describe, expect, it } from 'vitest';
import {
  base58Checksum,
  eip55,
  normaliseCrypto,
  parseCryptoAddress,
} from '@/src/core/detect/validators/crypto.ts';

// BIP-350, "Test vectors for v0-v16 native segregated witness addresses"
// (github.com/bitcoin/bips/blob/master/bip-0350.mediawiki): valid addresses
// with their scriptPubKey (witness version, program length).
const BIP350_VALID: readonly [string, number, number][] = [
  ['BC1QW508D6QEJXTDG4Y5R3ZARVARY0C5XW7KV8F3T4', 0, 20],
  ['tb1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3q0sl5k7', 0, 32],
  [
    'bc1pw508d6qejxtdg4y5r3zarvary0c5xw7kw508d6qejxtdg4y5r3zarvary0c5xw7kt5nd6y',
    1,
    40,
  ],
  ['BC1SW50QGDZ25J', 16, 2],
  ['bc1zw508d6qejxtdg4y5r3zarvaryvaxxpcs', 2, 16],
  ['tb1qqqqqp399et2xygdj5xreqhjjvcmzhxw4aywxecjdzew6hylgvsesrxh6hy', 0, 32],
  ['tb1pqqqqp399et2xygdj5xreqhjjvcmzhxw4aywxecjdzew6hylgvsesf3hn0c', 1, 32],
  ['bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0', 1, 32],
];

// BIP-350 invalid addresses, with the reason the BIP gives.
const BIP350_INVALID: readonly string[] = [
  'tc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vq5zuyut', // invalid human-readable part
  'bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqh2y7hd', // Bech32 instead of Bech32m
  'tb1z0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqglt7rf', // Bech32 instead of Bech32m
  'BC1S0XLXVLHEMJA6C4DQV22UAPCTQUPFHLXM9H8Z3K2E72Q4K9HCZ7VQ54WELL', // Bech32 instead of Bech32m
  'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kemeawh', // Bech32m instead of Bech32
  'tb1q0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vq24jc47', // Bech32m instead of Bech32
  'bc1p38j9r5y49hruaue7wxjce0updqjuyyx0kh56v8s25huc6995vvpql3jow4', // invalid character in checksum
  'BC130XLXVLHEMJA6C4DQV22UAPCTQUPFHLXM9H8Z3K2E72Q4K9HCZ7VQ7ZWS8R', // invalid witness version
  'bc1pw5dgrnzv', // program length 1 byte
  'bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7v8n0nx0muaewav253zgeav', // program length 41 bytes
  'BC1QR508D6QEJXTDG4Y5R3ZARVARYV98GJ9P', // v0 program length (BIP-141)
  'tb1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vq47Zagq', // mixed case
  'bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7v07qwwzcrf', // zero padding of more than 4 bits
  'tb1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vpggkg4j', // non-zero padding
  'bc1gmk9yu', // empty data section
];

// EIP-55 test cases (eips.ethereum.org/EIPS/eip-55).
const EIP55 = {
  upper: [
    '0x52908400098527886E0F7030069857D2E4169EE7',
    '0x8617E340B3D01FA5F11F306F4090FD50E238070D',
  ],
  lower: [
    '0xde709f2102306220921060314715629080e2fb77',
    '0x27b1fdb04752bbc536007a920d24acb045561c26',
  ],
  checksum: [
    '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed',
    '0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359',
    '0xdbF03B407c01E7cD3CBea99509d93f8DDDC8C6FB',
    '0xD1220A0cf47c7B9Be7A2E6BA89F429762e7b9aDb',
  ],
};

/** A Base58Check address built in memory from a made-up hash. */
function base58Address(version: number, label: string): string {
  const payload = new Uint8Array(21);
  payload[0] = version;
  payload.set(sha256(utf8ToBytes(label)).slice(0, 20), 1);
  const full = new Uint8Array(25);
  full.set(payload);
  full.set(base58Checksum(payload), 21);
  return base58.encode(full);
}

describe('Bitcoin SegWit addresses (BIP-350 vectors)', () => {
  it.each(BIP350_VALID)(
    'accepts %s (v%i, %i bytes)',
    (address, version, length) => {
      expect(parseCryptoAddress(address)).toEqual({
        kind: 'segwit',
        prefix: address.slice(0, 2).toLowerCase(),
        witnessVersion: version,
        programLength: length,
        upper: address === address.toUpperCase(),
      });
    },
  );

  it.each(BIP350_INVALID)('rejects %s', (address) => {
    expect(parseCryptoAddress(address)).toBeNull();
  });
});

describe('Bitcoin Base58Check addresses', () => {
  it('accepts the four version bytes with a valid checksum', () => {
    for (const version of [0x00, 0x05, 0x6f, 0xc4]) {
      for (let n = 0; n < 50; n += 1) {
        const address = base58Address(version, `test ${n.toString()}`);
        expect(parseCryptoAddress(address)).toEqual({
          kind: 'base58',
          version,
        });
      }
    }
    expect(base58Address(0x00, 'a')).toMatch(/^1/u);
    expect(base58Address(0x05, 'a')).toMatch(/^3/u);
  });

  it('rejects a changed character, other versions and other lengths', () => {
    for (let n = 0; n < 50; n += 1) {
      const address = base58Address(0x00, `change ${n.toString()}`);
      const i = 5 + (n % 20);
      const swapped = address.charAt(i) === 'a' ? 'b' : 'a';
      const changed = address.slice(0, i) + swapped + address.slice(i + 1);
      expect(parseCryptoAddress(changed), changed).toBeNull();
    }
    expect(parseCryptoAddress(base58Address(0x30, 'litecoin-like'))).toBeNull();
    // Too short for a 25-byte payload.
    expect(parseCryptoAddress('1abcdefghijkmnopqrs')).toBeNull();
    expect(parseCryptoAddress('1OIl0abcdefghijkmnopqrstuv')).toBeNull();
  });
});

describe('Ethereum addresses (EIP-55 vectors)', () => {
  it('reads the casing of every test case', () => {
    for (const [casing, addresses] of Object.entries(EIP55)) {
      for (const address of addresses) {
        expect(parseCryptoAddress(address)).toEqual({
          kind: 'ethereum',
          casing,
          prefix: '0x',
        });
      }
    }
  });

  it('computes the EIP-55 casing and rejects a wrong one', () => {
    for (const address of EIP55.checksum) {
      expect(`0x${eip55(address.slice(2).toLowerCase())}`).toBe(address);
      // The first letter in the other case (digits have none).
      const at = address.slice(2).search(/[A-Fa-f]/u) + 2;
      const wrong =
        address.slice(0, at) +
        swapCase(address.charAt(at)) +
        address.slice(at + 1);
      expect(parseCryptoAddress(wrong)).toBeNull();
    }
    expect(
      parseCryptoAddress('0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAe'),
    ).toBeNull();
  });
});

function swapCase(char: string): string {
  return char === char.toUpperCase() ? char.toLowerCase() : char.toUpperCase();
}

describe('crypto normal form', () => {
  it('lower-cases SegWit and Ethereum addresses, keeps Base58 as written', () => {
    const legacy = base58Address(0x00, 'normal form');
    expect(normaliseCrypto(` ${legacy} `)).toBe(legacy);
    expect(normaliseCrypto('BC1QW508D6QEJXTDG4Y5R3ZARVARY0C5XW7KV8F3T4')).toBe(
      'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4',
    );
    const [checksum = ''] = EIP55.checksum;
    expect(normaliseCrypto(checksum)).toBe(checksum.toLowerCase());
  });
});
