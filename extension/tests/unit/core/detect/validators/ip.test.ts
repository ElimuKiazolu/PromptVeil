import { describe, expect, it } from 'vitest';
import {
  classifyIp,
  expandIpv6,
  formatIpv6,
  normaliseIp,
  parseIp,
  parseIpv4,
  parseIpv6,
} from '@/src/core/detect/validators/ip.ts';

// Addresses from the documentation ranges (RFC 5737, RFC 3849), the
// local ranges the rule ignores, and RFC 5952's own examples.
const v6 = (text: string) => {
  const bytes = parseIpv6(text);
  if (bytes === null) throw new Error(`not IPv6: ${text}`);
  return bytes;
};

describe('IPv4', () => {
  it('reads four octets from 0 to 255 without leading zeros', () => {
    expect(parseIpv4('192.0.2.1')).toEqual([192, 0, 2, 1]);
    expect(parseIpv4('0.0.0.0')).toEqual([0, 0, 0, 0]);
    for (const bad of [
      '256.1.1.1',
      '192.0.2',
      '192.0.2.1.5',
      '192.0.02.1',
      '1.2.3.-4',
      '1..2.3',
    ]) {
      expect(parseIpv4(bad), bad).toBeNull();
    }
  });
});

describe('IPv6', () => {
  it('reads full, compressed and IPv4-tailed forms', () => {
    expect(formatIpv6(v6('2001:0db8:0000:0000:0000:0000:0000:0001'))).toBe(
      '2001:db8::1',
    );
    expect(formatIpv6(v6('2001:DB8::1'))).toBe('2001:db8::1');
    expect(formatIpv6(v6('::ffff:192.0.2.128'))).toBe('::ffff:c000:280');
    expect(v6('2001:db8::192.0.2.1').slice(12)).toEqual([192, 0, 2, 1]);
    expect(v6('::')).toEqual(new Array<number>(16).fill(0));
    for (const bad of [
      '2001:db8::1::2',
      '2001:db8:1:2:3:4:5:6:7',
      '2001:db8:1:2:3:4:5',
      '12:30:45',
      '00:1A:2B:3C:4D:5E',
      '2001:db8::g',
      '2001:db8:1:2:3:4:5::6:7',
      '2001:db8::12345',
      '2001:db8::1.2.3',
    ]) {
      expect(parseIpv6(bad), bad).toBeNull();
    }
  });

  it('writes RFC 5952 text and the full form', () => {
    // RFC 5952 §4: the longest zero run, the first of equal ones; a single
    // zero group is not shortened.
    expect(formatIpv6(v6('2001:db8:0:0:1:0:0:1'))).toBe('2001:db8::1:0:0:1');
    expect(formatIpv6(v6('2001:db8:0:1:1:1:1:1'))).toBe('2001:db8:0:1:1:1:1:1');
    expect(formatIpv6(v6('2001:db8::0:1'))).toBe('2001:db8::1');
    expect(expandIpv6(v6('2001:db8::1'))).toBe(
      '2001:0db8:0000:0000:0000:0000:0000:0001',
    );
  });
});

describe('IP classes', () => {
  const kind = (text: string) => {
    const ip = parseIp(text);
    if (ip === null) throw new Error(`not an IP: ${text}`);
    return classifyIp(ip);
  };

  it('knows the documentation ranges', () => {
    for (const text of [
      '192.0.2.10',
      '198.51.100.7',
      '203.0.113.200',
      '2001:db8::1',
      '2001:DB8:FFFF::1',
      '::ffff:192.0.2.5',
    ]) {
      expect(kind(text), text).toBe('documentation');
    }
  });

  it('knows the local ranges', () => {
    for (const text of [
      '10.1.2.3',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.1.10',
      '127.0.0.1',
      '169.254.10.20',
      '100.64.0.1',
      '0.0.0.0',
      '224.0.0.251',
      '255.255.255.255',
      '198.18.0.1',
      '::1',
      '::',
      'fe80::1',
      'fd12:3456::1',
      'ff02::1',
      '::ffff:10.0.0.1',
    ]) {
      expect(kind(text), text).toBe('local');
    }
  });

  it('treats the edges of the local ranges correctly', () => {
    // Just outside 172.16.0.0/12, 100.64.0.0/10 and 198.18.0.0/15; the host
    // part is generated in memory (no address is written into the tests).
    for (let n = 1; n < 200; n += 1) {
      const host = `${(n % 256).toString()}.${((n * 7) % 255).toString()}`;
      for (const net of ['172.32', '100.128', '198.20']) {
        expect(kind(`${net}.${host}`), `${net}.${host}`).toBe('public');
      }
      expect(kind(`172.31.${host}`)).toBe('local');
      expect(kind(`100.127.${host}`)).toBe('local');
      expect(kind(`198.19.${host}`)).toBe('local');
    }
  });
});

describe('IP normal form', () => {
  it('writes every form of one address alike', () => {
    expect(normaliseIp(' 2001:0DB8:0:0::0001 ')).toBe('2001:db8::1');
    expect(normaliseIp('192.0.2.1')).toBe('192.0.2.1');
  });
});
