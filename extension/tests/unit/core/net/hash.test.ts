import { describe, expect, it } from 'vitest';
import {
  createValueHasher,
  hmacSha256Hex,
  normaliseValue,
  randomHashKey,
} from '@/src/core/net/hash.ts';

const hex = (text: string): string =>
  Array.from(new TextEncoder().encode(text), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('');

const bytes = (hexText: string): Uint8Array =>
  Uint8Array.from(hexText.match(/../g) ?? [], (h) => Number.parseInt(h, 16));

// RFC 4231, HMAC-SHA-256 test cases (case 5 tests truncation and is omitted).
const RFC_4231 = [
  {
    name: 'case 1',
    key: '0b'.repeat(20),
    data: hex('Hi There'),
    mac: 'b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7',
  },
  {
    name: 'case 2',
    key: hex('Jefe'),
    data: hex('what do ya want for nothing?'),
    mac: '5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843',
  },
  {
    name: 'case 3',
    key: 'aa'.repeat(20),
    data: 'dd'.repeat(50),
    mac: '773ea91e36800e46854db8ebd09181a72959098b3ef8c122d9635514ced565fe',
  },
  {
    name: 'case 4',
    key: '0102030405060708090a0b0c0d0e0f10111213141516171819',
    data: 'cd'.repeat(50),
    mac: '82558a389a443c0ea4cc819899f2083a85f0faa3e578f8077a2e3ff46729665b',
  },
  {
    name: 'case 6',
    key: 'aa'.repeat(131),
    data: hex('Test Using Larger Than Block-Size Key - Hash Key First'),
    mac: '60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54',
  },
  {
    name: 'case 7',
    key: 'aa'.repeat(131),
    data: hex(
      'This is a test using a larger than block-size key and a larger than block-size data. The key needs to be hashed before being used by the HMAC algorithm.',
    ),
    mac: '9b09ffa71b942fcb27635fbcd5b0e944bfdc63644f0713938a7f51535c3a35e2',
  },
];

describe('hmacSha256Hex', () => {
  it.each(RFC_4231)('matches RFC 4231 $name', ({ key, data, mac }) => {
    expect(hmacSha256Hex(key, bytes(data))).toBe(mac);
  });

  it('hashes strings as UTF-8', () => {
    expect(hmacSha256Hex(hex('Jefe'), 'what do ya want for nothing?')).toBe(
      RFC_4231[1]?.mac,
    );
  });
});

describe('createValueHasher', () => {
  const KEY_A = 'a1'.repeat(32);
  const KEY_B = 'b2'.repeat(32);

  it('hashes the normalised value, so case and spacing do not matter', () => {
    const hash = createValueHasher(KEY_A);
    expect(hash('email', ' Dana@Example.COM ')).toBe(
      hash('email', 'dana@example.com'),
    );
    expect(hash('email', 'dana@example.com')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('gives different hashes for different keys and values', () => {
    const a = createValueHasher(KEY_A);
    const b = createValueHasher(KEY_B);
    expect(a('email', 'dana@example.com')).not.toBe(
      b('email', 'dana@example.com'),
    );
    expect(a('email', 'dana@example.com')).not.toBe(
      a('email', 'ops@example.org'),
    );
  });

  it('never returns the value itself', () => {
    const hash = createValueHasher(KEY_A)('email', 'dana@example.com');
    expect(hash).not.toContain('dana');
  });

  it('rejects malformed keys', () => {
    expect(() => createValueHasher('short')).toThrow(RangeError);
    expect(() => createValueHasher('A1'.repeat(32))).toThrow(RangeError);
  });
});

describe('normaliseValue and randomHashKey', () => {
  it('normalises emails by trimming and lower-casing', () => {
    expect(normaliseValue('email', '  Dana@Example.Com\n')).toBe(
      'dana@example.com',
    );
  });

  it('builds a 32-byte hex key from the random source', () => {
    const key = randomHashKey((buffer) => buffer.fill(171));
    expect(key).toBe('ab'.repeat(32));
    expect(() => createValueHasher(key)).not.toThrow();
  });
});
