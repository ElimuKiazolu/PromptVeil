/**
 * Global IP rule (TR §4.2, P1). IPv4 dotted quads and IPv6 addresses, read
 * by bounded patterns and checked by the IP validator:
 *
 * - Documentation ranges (what IP stand-ins use) are reserved findings: no
 *   one's address, never reported, and no other reading surfaces instead.
 * - Private, loopback, link-local and other local ranges are not reported
 *   unless settings.maskPrivateIps is on (RuleEnv.maskPrivateIps).
 * - Version numbers stay out: a quad after a letter, a dot or a version
 *   word, or followed by another ".digit", is not read; IPv6 needs at least
 *   three written groups (so "::1", times and C++ "a::b" are not read).
 */
import type { Span } from '../text.ts';
import { classifyIp, parseIp } from '../validators/ip.ts';
import { INVALID, finding, type Rule } from './types.ts';

const IPV4 = /(?<![\w.])(?:\d{1,3}\.){3}\d{1,3}(?!\w|\.\d)/gu;
const IPV6 =
  /(?<![\w:.])(?:[0-9A-Fa-f]{0,4}:){2,7}(?:(?:\d{1,3}\.){3}\d{1,3}|[0-9A-Fa-f]{1,4})?(?![\w:])/gu;

/** IPv6 groups written out (an IPv4 tail counts as two). */
function writtenGroups(value: string): number {
  const groups = value.split(':').filter((group) => group !== '');
  const tail = groups.at(-1)?.includes('.') === true ? 1 : 0;
  return groups.length + tail;
}

function* findIpCandidates(text: string): Generator<Span> {
  for (const pattern of [IPV4, IPV6]) {
    const scan = new RegExp(pattern.source, pattern.flags);
    for (let match = scan.exec(text); match !== null; match = scan.exec(text)) {
      if (match[0].length === 0) {
        scan.lastIndex += 1;
        continue;
      }
      yield { start: match.index, end: match.index + match[0].length };
    }
  }
}

export const IP_RULE: Rule = {
  id: 'global.ip',
  type: 'IP',
  subtype: null,
  country: null,
  find: findIpCandidates,
  validate(value, env) {
    const ip = parseIp(value);
    if (ip === null) return INVALID;
    if (ip.version === 6 && writtenGroups(value) < 3) return INVALID;
    const kind = classifyIp(ip);
    if (kind === 'documentation') {
      return finding(IP_RULE, 'structural', { reserved: true });
    }
    if (kind === 'local' && env.maskPrivateIps !== true) return INVALID;
    return finding(IP_RULE, 'structural');
  },
  context: {
    words: [
      'ip',
      'ip address',
      'ipv4',
      'ipv6',
      'host',
      'server',
      'gateway',
      'dns',
      'ping',
      'ssh',
      'vpn',
      'router',
    ],
    before: 30,
    after: 16,
  },
  contextRequired: false,
  negativeContext: [
    {
      words: ['version', 'ver', 'v', 'release', 'build', 'firmware', 'oid'],
      before: 16,
      after: 0,
    },
  ],
  confidence: { validated: 0.95, context: 0.95, none: 0.9 },
};
