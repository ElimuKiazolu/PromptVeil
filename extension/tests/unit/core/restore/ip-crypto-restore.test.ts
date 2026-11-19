import { sha256 } from '@noble/hashes/sha2.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import { base58 } from '@scure/base';
import { describe, expect, it } from 'vitest';
import { base58Checksum } from '@/src/core/detect/validators/crypto.ts';
import { netForms } from '@/src/core/net/forms.ts';
import { createRestoreMatcher } from '@/src/core/restore/matcher.ts';
import type { StandInMapping } from '@/src/core/restore/types.ts';

// Stand-ins are documentation addresses and in-memory Base58 addresses;
// real values are made-up stand-ins for real ones.
function base58Address(label: string): string {
  const payload = new Uint8Array(21);
  payload.set(sha256(utf8ToBytes(label)).slice(0, 20), 1);
  const full = new Uint8Array(25);
  full.set(payload);
  full.set(base58Checksum(payload), 21);
  return base58.encode(full);
}

function restore(mappings: StandInMapping[], text: string): string {
  const matcher = createRestoreMatcher(mappings);
  let out = text;
  for (const found of matcher.find(text).reverse()) {
    out = out.slice(0, found.start) + found.real + out.slice(found.end);
  }
  return out;
}

describe('restoring IP and crypto stand-ins', () => {
  it('restores a Base58 address only as written (its case is part of it)', () => {
    const standIn = base58Address('stand-in');
    const real = base58Address('real');
    const mappings: StandInMapping[] = [{ standIn, real, boundary: 'exact' }];
    expect(restore(mappings, `Pay ${standIn} now`)).toBe(`Pay ${real} now`);
    expect(restore(mappings, `Pay ${standIn.toLowerCase()} now`)).toBe(
      `Pay ${standIn.toLowerCase()} now`,
    );
    expect(restore(mappings, `Pay x${standIn} now`)).toBe(
      `Pay x${standIn} now`,
    );
  });

  it('restores IP addresses as whole words, IPv6 in any case', () => {
    const mappings: StandInMapping[] = [
      { standIn: '198.51.100.23', real: '198.51.100.99', boundary: 'word' },
      { standIn: '2001:db8::42', real: '2001:db8::7', boundary: 'word' },
    ];
    expect(restore(mappings, 'Host 198.51.100.23, v6 2001:DB8::42.')).toBe(
      'Host 198.51.100.99, v6 2001:db8::7.',
    );
    // Part of a longer number: left alone.
    expect(restore(mappings, 'Host 198.51.100.234')).toBe(
      'Host 198.51.100.234',
    );
  });
});

describe('request net forms for IP addresses', () => {
  it('cover the address as written, normalised and written out in full', () => {
    expect(netForms('IP', '2001:DB8:0:0::1', '2001:db8::1')).toEqual([
      '2001db8001',
      '2001db81',
      '20010db8000000000000000000000001',
    ]);
    expect(netForms('IP', '203.0.113.200', '203.0.113.200')).toEqual([
      '2030113200',
    ]);
    // Shorter than six characters once compacted: not covered (as before).
    expect(netForms('IP', '1.2.3.4', '1.2.3.4')).toEqual([]);
  });
});
