import { sha256 } from '@noble/hashes/sha2.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import { base58 } from '@scure/base';
import { describe, expect, it } from 'vitest';
import { normaliseReal } from '@/src/core/detect/normal-form.ts';
import { detectRules } from '@/src/core/detect/rules/detector.ts';
import { base58Checksum } from '@/src/core/detect/validators/crypto.ts';
import {
  classifyIp,
  parseIp,
  parseIpv6,
} from '@/src/core/detect/validators/ip.ts';
import {
  generateStandIn,
  isWellFormedStandIn,
} from '@/src/core/surrogate/engine.ts';
import type { StandInRequest } from '@/src/core/surrogate/types.ts';
import type { Detection, EntityType } from '@/src/shared/entities.ts';

// Public addresses and Base58 addresses are generated in memory from fixed
// seeds (none is written into the tests); SegWit and Ethereum examples are
// the BIP-350 and EIP-55 test vectors.
const bytesOf = (label: string): Uint8Array => sha256(utf8ToBytes(label));

/** A public IPv4 address (no local or documentation range). */
function publicIpv4(n: number): string {
  for (let k = 0; ; k += 1) {
    const b = bytesOf(`ipv4 ${n.toString()} ${k.toString()}`);
    const text = `${(b[0] ?? 1).toString()}.${(b[1] ?? 0).toString()}.${(
      b[2] ?? 0
    ).toString()}.${(b[3] ?? 1).toString()}`;
    const ip = parseIp(text);
    if (ip !== null && classifyIp(ip) === 'public') return text;
  }
}

/** A public IPv6 address under 2000::/3, compressed form. */
function publicIpv6(n: number): string {
  const b = bytesOf(`ipv6 ${n.toString()}`);
  const group = (i: number) =>
    (((b[i] ?? 0) << 8) | (b[i + 1] ?? 0)).toString(16);
  const first = (0x2400 + ((b[0] ?? 0) % 0x1000)).toString(16);
  return `${first}:${group(2)}:${group(4)}:${group(6)}::${group(8)}`;
}

/** A public IPv6 address with all eight groups written in four digits. */
function fullIpv6(n: number): string {
  const b = bytesOf(`ipv6 full ${n.toString()}`);
  const groups = [(0x2400 + ((b[0] ?? 0) % 0x1000)).toString(16)];
  for (let i = 2; i < 16; i += 2) {
    groups.push(
      (((b[i] ?? 0) << 8) | (b[i + 1] ?? 0)).toString(16).padStart(4, '0'),
    );
  }
  return groups.join(':');
}

function base58Address(version: number, label: string): string {
  const payload = new Uint8Array(21);
  payload[0] = version;
  payload.set(bytesOf(label).slice(0, 20), 1);
  const full = new Uint8Array(25);
  full.set(payload);
  full.set(base58Checksum(payload), 21);
  return base58.encode(full);
}

const SEGWIT = [
  'BC1QW508D6QEJXTDG4Y5R3ZARVARY0C5XW7KV8F3T4',
  'tb1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3q0sl5k7',
  'bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0',
];
const ETH_CHECKSUM = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed';
const ETH_LOWER = '0xde709f2102306220921060314715629080e2fb77';

async function detect(
  text: string,
  options: { maskPrivateIps?: boolean; types?: EntityType[] } = {},
): Promise<Detection[]> {
  return detectRules(text, {
    homeRegions: ['GB'],
    entityTypes: new Set<EntityType>(
      options.types ?? ['IP', 'CRYPTO', 'PHONE', 'CARD', 'SECRET'],
    ),
    packs: [],
    exclude: [],
    maskPrivateIps: options.maskPrivateIps ?? false,
  });
}

const found = (detections: readonly Detection[]) =>
  detections.map((d) => `${d.type}:${d.status}:${d.value}`);

describe('IP detection', () => {
  it('finds public IPv4 and IPv6 addresses in text', async () => {
    for (let n = 0; n < 40; n += 1) {
      const v4 = publicIpv4(n);
      const v6 = publicIpv6(n);
      const text = `Our server is ${v4}, the backup ${v6}, port 22.`;
      expect(found(await detect(text)), text).toEqual([
        `IP:confirmed:${v4}`,
        `IP:confirmed:${v6}`,
      ]);
    }
    const v4 = publicIpv4(99);
    expect(found(await detect(`ssh root@${v4}:2222`))).toEqual([
      `IP:confirmed:${v4}`,
    ]);
    expect(found(await detect(`route ${v4}/24 via gateway`))).toEqual([
      `IP:confirmed:${v4}`,
    ]);
    const v6 = publicIpv6(98);
    expect(found(await detect(`http://[${v6}]:8080/`))).toEqual([
      `IP:confirmed:${v6}`,
    ]);
  });

  it('leaves version numbers, times, MAC addresses and code alone', async () => {
    for (const text of [
      'Update to version 1.2.3.4 today.',
      'Released v2.10.1.0 and 3.4.5.6.7.',
      'Build 10.0.19041.1 is out.',
      'OID 1.3.6.1.4.1.311 is registered.',
      'The meeting is at 12:30:45 sharp.',
      'MAC 00:1A:2B:3C:4D:5E on eth0.',
      'Use std::vector<int> and a::b::c.',
      'Loopback ::1 and the unspecified ::.',
    ]) {
      expect(found(await detect(text)), text).toEqual([]);
    }
  });

  it('ignores local addresses unless maskPrivateIps is on', async () => {
    const text =
      'Router 192.168.1.1, host 10.0.0.5, link fe80::1:2:3, lo 127.0.0.1.';
    expect(found(await detect(text))).toEqual([]);
    expect(
      found(await detect(text, { maskPrivateIps: true })).map(
        (entry) => entry.split(':')[0],
      ),
    ).toEqual(['IP', 'IP', 'IP', 'IP']);
  });

  it('never reports a documentation address (what stand-ins use)', async () => {
    for (const text of [
      'Server 192.0.2.10, backup 198.51.100.7, edge 203.0.113.200.',
      'IPv6 2001:db8::1 and 2001:DB8:0:0:8:800:200C:417A.',
    ]) {
      expect(found(await detect(text, { maskPrivateIps: true }))).toEqual([]);
    }
  });
});

describe('CRYPTO detection', () => {
  it('confirms Bitcoin addresses by their checksums', async () => {
    const legacy = base58Address(0x00, 'p2pkh');
    const script = base58Address(0x05, 'p2sh');
    for (const address of [legacy, script, ...SEGWIT]) {
      expect(found(await detect(`Pay to ${address} please.`))).toEqual([
        `CRYPTO:confirmed:${address}`,
      ]);
    }
  });

  it('rejects addresses with a broken checksum and other base58 text', async () => {
    const legacy = base58Address(0x00, 'broken');
    const broken = `${legacy.slice(0, -1)}${legacy.endsWith('a') ? 'b' : 'a'}`;
    for (const text of [
      `Send to ${broken}.`,
      'Send to bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kemeawh.',
      // Base58 text without an address checksum (an IPFS-style hash).
      `IPFS Qm${base58.encode(bytesOf('content'))} is a hash.`,
      `Ref ${base58.encode(bytesOf('reference').slice(0, 25))} here.`,
      `SHA-256 ${Buffer.from(bytesOf('x')).toString('hex')}.`,
    ]) {
      // The generic secret rule may still flag random-looking text.
      expect(
        found(await detect(text)).filter((entry) => entry.startsWith('CRYPTO')),
        text,
      ).toEqual([]);
    }
  });

  it('confirms an EIP-55 address; a lower-case one needs a wallet word', async () => {
    expect(found(await detect(`Send to ${ETH_CHECKSUM}.`))).toEqual([
      `CRYPTO:confirmed:${ETH_CHECKSUM}`,
    ]);
    expect(found(await detect(`Value ${ETH_LOWER} here.`))).toEqual([
      `CRYPTO:possible:${ETH_LOWER}`,
    ]);
    expect(found(await detect(`My wallet is ${ETH_LOWER}.`))).toEqual([
      `CRYPTO:confirmed:${ETH_LOWER}`,
    ]);
    // Named as a hash: not an address.
    expect(found(await detect(`commit ${ETH_LOWER}`))).toEqual([]);
    // A 64-digit transaction hash is not an address.
    const tx = `0x${Buffer.from(bytesOf('tx')).toString('hex')}`;
    expect(found(await detect(`tx ${tx}`))).toEqual([]);
  });
});

function request(type: 'IP' | 'CRYPTO', value: string): StandInRequest {
  return {
    type,
    subtype: null,
    country: null,
    value,
    normalised: normaliseReal(type, null, null, value),
    dateOffsetDays: 40,
    number: 1,
    now: 0,
  };
}

const seed = (n: number) => bytesOf(`stand-in seed ${n.toString()}`);

describe('IP stand-ins', () => {
  it('come from the documentation ranges, same version, never detected', async () => {
    const seen = new Set<string>();
    for (let n = 0; n < 50; n += 1) {
      const real = request('IP', publicIpv4(n));
      const standIn = generateStandIn(real, seed(n), 0);
      if (standIn === null) throw new Error('no stand-in');
      expect(standIn.value).toMatch(
        /^(?:192\.0\.2|198\.51\.100|203\.0\.113)\.(?:[1-9]\d?|1\d\d|2[0-4]\d|25[0-4])$/u,
      );
      expect(isWellFormedStandIn(real, standIn.value)).toBe(true);
      expect(generateStandIn(real, seed(n), 0)).toEqual(standIn);
      seen.add(standIn.value);
      expect(await detect(`Server ${standIn.value}`)).toEqual([]);
    }
    expect(seen.size).toBeGreaterThan(40);
  });

  it('keep an IPv6 address shape: groups, "::", case and an IPv4 tail', () => {
    const shapes: [string, RegExp][] = [
      [publicIpv6(1), /^2001:db8:[0-9a-f]{1,4}:[0-9a-f]{1,4}::[0-9a-f]{1,4}$/u],
      [
        publicIpv6(2).toUpperCase(),
        /^2001:DB8:[0-9A-F]{1,4}:[0-9A-F]{1,4}::[0-9A-F]{1,4}$/u,
      ],
      [fullIpv6(3), /^2001:0db8(?::[0-9a-f]{4}){6}$/u],
      [
        `${publicIpv6(4).split('::')[0] ?? ''}::${publicIpv4(4)}`,
        /^2001:db8:[0-9a-f]{1,4}:[0-9a-f]{1,4}::(?:192\.0\.2|198\.51\.100|203\.0\.113)\.\d+$/u,
      ],
      [
        `::ffff:${publicIpv4(5)}`,
        /^::ffff:(?:192\.0\.2|198\.51\.100|203\.0\.113)\.\d+$/u,
      ],
      [`${publicIpv6(6).split(':')[0] ?? ''}::7`, /^2001:db8::[0-9a-f]$/u],
    ];
    for (const [value, shape] of shapes) {
      const real = request('IP', value);
      for (let n = 0; n < 20; n += 1) {
        const standIn = generateStandIn(real, seed(n), 0);
        expect(standIn?.value, value).toMatch(shape);
        expect(parseIpv6(standIn?.value ?? '')).not.toBeNull();
        expect(isWellFormedStandIn(real, standIn?.value ?? '')).toBe(true);
      }
    }
  });
});

describe('CRYPTO stand-ins', () => {
  it('keep the chain, format and case style with a valid checksum', async () => {
    const values = [
      base58Address(0x00, 'real p2pkh'),
      base58Address(0x05, 'real p2sh'),
      base58Address(0x6f, 'real testnet'),
      ...SEGWIT,
      ETH_CHECKSUM,
      ETH_LOWER,
      ETH_LOWER.toUpperCase().replace('0X', '0x'),
    ];
    for (const value of values) {
      const real = request('CRYPTO', value);
      for (let n = 0; n < 20; n += 1) {
        const standIn = generateStandIn(real, seed(n), 0);
        if (standIn === null) throw new Error('no stand-in');
        expect(isWellFormedStandIn(real, standIn.value), standIn.value).toBe(
          true,
        );
        expect(standIn.value).not.toBe(value);
        expect(standIn.value.length).toBe(value.length);
        expect(generateStandIn(real, seed(n), 0)).toEqual(standIn);
      }
    }
    // A checksummed stand-in is confirmed like the real address would be.
    const standIn = generateStandIn(
      request('CRYPTO', ETH_CHECKSUM),
      seed(1),
      0,
    );
    expect(
      found(await detect(`Send to ${standIn?.value ?? ''}.`)).map((entry) =>
        entry.split(':').slice(0, 2).join(':'),
      ),
    ).toEqual(['CRYPTO:confirmed']);
  });
});
