/**
 * IP stand-ins (TR-S2): an address of the same version from the ranges
 * reserved for documentation, which route nowhere (RFC 5737 for IPv4:
 * 192.0.2.0/24, 198.51.100.0/24, 203.0.113.0/24; RFC 3849 for IPv6:
 * 2001:db8::/32). The detector never reports them, so a stand-in is never
 * masked again.
 *
 * IPv4: one of the three blocks, host 1–254. IPv6 keeps the real address's
 * shape: the same groups written before and after "::" (at least the two of
 * the 2001:db8 prefix before it), the same digits per group, the same case,
 * and an IPv4 tail where the real one has one (an IPv4-mapped address maps
 * to a documentation IPv4 address).
 */
import {
  classifyIp,
  IPV4_DOCUMENTATION,
  parseIp,
  parseIpv6,
} from '../detect/validators/ip.ts';
import type { Rng } from './rng.ts';
import type { Generator } from './types.ts';

const HEX = '0123456789abcdef';
const HEX_NON_ZERO = '123456789abcdef';

function ipv4(rng: Rng): string {
  const [prefix] = rng.pick(IPV4_DOCUMENTATION);
  return `${prefix.slice(0, 3).join('.')}.${rng.between(1, 254).toString()}`;
}

/** A hex group as wide as `like`, without a leading zero unless it had one. */
function groupLike(rng: Rng, like: string): string {
  if (like.length <= 1) return rng.char(HEX);
  const first = like.startsWith('0') ? rng.char(HEX) : rng.char(HEX_NON_ZERO);
  return first + rng.chars(HEX, like.length - 1);
}

function ipv6(rng: Rng, real: string): string | null {
  const upper = /[A-F]/u.test(real);
  const lastColon = real.lastIndexOf(':');
  const hasV4Tail = real.includes('.', lastColon);
  const body = hasV4Tail ? real.slice(0, lastColon + 1) : real;
  const mapped = /^::ffff:$/iu.test(body);
  let out: string;
  if (mapped) {
    out = `${body}${ipv4(rng)}`;
  } else {
    const compressed = body.includes('::');
    const [headText = '', tailText = ''] = compressed
      ? body.split('::')
      : [body.replace(/:$/u, ''), ''];
    const head = headText === '' ? [] : headText.split(':');
    const tail = tailText === '' ? [] : tailText.split(':');
    // The documentation prefix takes the first two groups.
    // Written with leading zeros ("0db8") only if the real address pads.
    const padded = [...head, ...tail].some(
      (group) => group.length === 4 && group.startsWith('0'),
    );
    const prefixWidth = padded ? '0db8' : 'db8';
    const groups = [
      '2001',
      prefixWidth,
      ...head.slice(2).map((group) => groupLike(rng, group)),
    ];
    const v4 = hasV4Tail ? ipv4(rng) : null;
    // "::" must still stand for a zero group after the prefix was added.
    const room = 7 - groups.length - (v4 === null ? 0 : 2);
    const rest = tail
      .slice(Math.max(0, tail.length - room))
      .map((group) => groupLike(rng, group));
    if (compressed) {
      out = `${groups.join(':')}::${rest.join(':')}`;
    } else {
      out = groups.join(':');
    }
    if (v4 !== null) out += out.endsWith(':') ? v4 : `:${v4}`;
  }
  out = upper ? out.toUpperCase() : out;
  return parseIpv6(out) === null ? null : out;
}

export const ipStandIn: Generator = ({ request, rng }) => {
  const real = parseIp(request.value);
  if (real === null) return null;
  const value = real.version === 4 ? ipv4(rng) : ipv6(rng, request.value);
  return value === null ? null : { value, reserved: true };
};

/** The same IP version, in a documentation range. */
export function isWellFormedIpStandIn(standIn: string, real: string): boolean {
  const candidate = parseIp(standIn);
  const original = parseIp(real);
  return (
    candidate !== null &&
    original !== null &&
    candidate.version === original.version &&
    classifyIp(candidate) === 'documentation'
  );
}
