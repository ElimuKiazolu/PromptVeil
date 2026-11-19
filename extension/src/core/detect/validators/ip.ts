/**
 * IP addresses (TR §4.2): parsing, the ranges that are not anyone's address
 * on the internet, and the normal form.
 *
 * - IPv4: four decimal octets 0–255, no leading zeros ("010" reads as octal
 *   in some tools, so it is not taken as an address).
 * - IPv6: up to eight groups of 1–4 hex digits, at most one "::", an IPv4
 *   tail allowed in the last 32 bits (RFC 4291 §2.2); no zone index.
 *
 * Classes: `documentation` (RFC 5737, RFC 3849: what IP stand-ins use, so
 * never detected), `local` (private, loopback, link-local, shared CGNAT,
 * multicast, reserved, unspecified, broadcast; ignored unless the setting
 * maskPrivateIps is on), and `public`.
 */

export type IpVersion = 4 | 6;
export type IpClass = 'public' | 'local' | 'documentation';

export interface ParsedIp {
  readonly version: IpVersion;
  /** IPv4: 4 octets. IPv6: 16 bytes. */
  readonly bytes: readonly number[];
}

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u;
const OCTET = /^(?:0|[1-9]\d{0,2})$/u;
const HEX_GROUP = /^[0-9A-Fa-f]{1,4}$/u;

export function parseIpv4(text: string): number[] | null {
  const match = IPV4.exec(text);
  if (match === null) return null;
  const octets: number[] = [];
  for (const part of match.slice(1)) {
    if (!OCTET.test(part)) return null;
    const value = Number(part);
    if (value > 255) return null;
    octets.push(value);
  }
  return octets;
}

function groupsOf(part: string): number[] | null {
  if (part === '') return [];
  const groups: number[] = [];
  for (const group of part.split(':')) {
    if (!HEX_GROUP.test(group)) return null;
    groups.push(Number.parseInt(group, 16));
  }
  return groups;
}

export function parseIpv6(text: string): number[] | null {
  if (text.length < 2 || text.length > 45) return null;
  let body = text;
  let tail: number[] = [];
  const lastColon = body.lastIndexOf(':');
  if (body.includes('.', lastColon)) {
    // An IPv4 tail fills the last two groups.
    const v4 = parseIpv4(body.slice(lastColon + 1));
    if (v4 === null) return null;
    tail = [v4[0] ?? 0, v4[1] ?? 0, v4[2] ?? 0, v4[3] ?? 0];
    body = body.slice(0, lastColon + 1);
    // "::1.2.3.4" keeps its "::"; "a:b:…:1.2.3.4" drops the trailing colon.
    if (!body.endsWith('::')) body = body.slice(0, -1);
  }
  const tailGroups = tail.length / 2;
  const halves = body.split('::');
  if (halves.length > 2) return null;
  let groups: number[];
  if (halves.length === 2) {
    const head = groupsOf(halves[0] ?? '');
    const rest = groupsOf(halves[1] ?? '');
    if (head === null || rest === null) return null;
    const missing = 8 - tailGroups - head.length - rest.length;
    // "::" stands for at least one group.
    if (missing < 1) return null;
    groups = [...head, ...new Array<number>(missing).fill(0), ...rest];
  } else {
    const all = groupsOf(body);
    if (all === null || all.length + tailGroups !== 8) return null;
    groups = all;
  }
  const bytes: number[] = [];
  for (const group of groups) bytes.push(group >> 8, group & 0xff);
  return [...bytes, ...tail];
}

export function parseIp(text: string): ParsedIp | null {
  const v4 = parseIpv4(text);
  if (v4 !== null) return { version: 4, bytes: v4 };
  if (!text.includes(':')) return null;
  const v6 = parseIpv6(text);
  return v6 === null ? null : { version: 6, bytes: v6 };
}

/** The address's first `bits` bits equal the prefix's. */
function inPrefix(
  bytes: readonly number[],
  prefix: readonly number[],
  bits: number,
): boolean {
  for (let bit = 0; bit < bits; bit += 1) {
    const index = Math.floor(bit / 8);
    const mask = 0x80 >> (bit % 8);
    if (((bytes[index] ?? 0) & mask) !== ((prefix[index] ?? 0) & mask)) {
      return false;
    }
  }
  return true;
}

type Range = readonly [readonly number[], number];

/** RFC 5737 TEST-NET-1, -2, -3. */
export const IPV4_DOCUMENTATION: readonly Range[] = [
  [[192, 0, 2, 0], 24],
  [[198, 51, 100, 0], 24],
  [[203, 0, 113, 0], 24],
];

/** RFC 3849. */
export const IPV6_DOCUMENTATION: Range = [[0x20, 0x01, 0x0d, 0xb8], 32];

const IPV4_LOCAL: readonly Range[] = [
  [[0, 0, 0, 0], 8], // "this network" (RFC 791)
  [[10, 0, 0, 0], 8], // private (RFC 1918)
  [[100, 64, 0, 0], 10], // shared, carrier-grade NAT (RFC 6598)
  [[127, 0, 0, 0], 8], // loopback
  [[169, 254, 0, 0], 16], // link-local (RFC 3927)
  [[172, 16, 0, 0], 12], // private
  [[192, 0, 0, 0], 24], // IETF protocol assignments (RFC 6890)
  [[192, 168, 0, 0], 16], // private
  [[198, 18, 0, 0], 15], // benchmarking (RFC 2544)
  [[224, 0, 0, 0], 4], // multicast
  [[240, 0, 0, 0], 4], // reserved, and the limited broadcast address
];

const IPV6_LOCAL: readonly Range[] = [
  [[0xfc], 7], // unique local (RFC 4193)
  [[0xfe, 0x80], 10], // link-local
  [[0xff], 8], // multicast
];

const IPV4_MAPPED = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff];

export function classifyIp(ip: ParsedIp): IpClass {
  const { bytes } = ip;
  if (ip.version === 4) {
    if (IPV4_DOCUMENTATION.some(([p, n]) => inPrefix(bytes, p, n))) {
      return 'documentation';
    }
    return IPV4_LOCAL.some(([p, n]) => inPrefix(bytes, p, n))
      ? 'local'
      : 'public';
  }
  if (inPrefix(bytes, IPV4_MAPPED, 96)) {
    return classifyIp({ version: 4, bytes: bytes.slice(12) });
  }
  if (inPrefix(bytes, IPV6_DOCUMENTATION[0], IPV6_DOCUMENTATION[1])) {
    return 'documentation';
  }
  // The unspecified address and loopback (::, ::1).
  if (bytes.slice(0, 15).every((byte) => byte === 0)) return 'local';
  return IPV6_LOCAL.some(([p, n]) => inPrefix(bytes, p, n))
    ? 'local'
    : 'public';
}

/** The eight groups of an IPv6 address. */
function groups16(bytes: readonly number[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < 16; i += 2) {
    out.push(((bytes[i] ?? 0) << 8) | (bytes[i + 1] ?? 0));
  }
  return out;
}

/** RFC 5952 text: lower case, no leading zeros, the longest zero run as "::". */
export function formatIpv6(bytes: readonly number[]): string {
  const groups = groups16(bytes);
  let bestStart = -1;
  let bestLength = 1;
  for (let i = 0; i < 8;) {
    if (groups[i] !== 0) {
      i += 1;
      continue;
    }
    let j = i;
    while (j < 8 && groups[j] === 0) j += 1;
    if (j - i > bestLength) {
      bestStart = i;
      bestLength = j - i;
    }
    i = j;
  }
  const text = (part: number[]) => part.map((g) => g.toString(16)).join(':');
  if (bestStart < 0) return text(groups);
  return `${text(groups.slice(0, bestStart))}::${text(
    groups.slice(bestStart + bestLength),
  )}`;
}

/** All eight groups written out with four digits (for net forms). */
export function expandIpv6(bytes: readonly number[]): string {
  return groups16(bytes)
    .map((group) => group.toString(16).padStart(4, '0'))
    .join(':');
}

/**
 * The normal form: dotted decimal for IPv4, RFC 5952 text for IPv6, so every
 * writing of one address shares a mapping.
 */
export function normaliseIp(value: string): string {
  const ip = parseIp(value.trim());
  if (ip === null) return value.trim().toLowerCase();
  return ip.version === 4 ? ip.bytes.join('.') : formatIpv6(ip.bytes);
}
