/**
 * Global CRYPTO rules (TR §4.2, P1).
 *
 * - Bitcoin: Base58Check and bech32/bech32m addresses carry a checksum
 *   random text cannot hit (2^-32 or better), so they are confirmed.
 * - Ethereum: the EIP-55 casing is a checksum (confirmed); an address all
 *   in lower or upper case has none and looks like any 160-bit hex value,
 *   so it is confirmed only next to a wallet word and "possible" otherwise,
 *   and words that name hashes (tx, hash, commit…) veto it.
 */
import type { Span } from '../text.ts';
import { parseCryptoAddress } from '../validators/crypto.ts';
import { INVALID, finding, type Rule } from './types.ts';

const BITCOIN =
  /(?<![\w])(?:[13mn2][1-9A-HJ-NP-Za-km-z]{24,34}|(?:bc|tb|BC|TB)1[02-9ac-hj-np-zAC-HJ-NP-Z]{8,87})(?![\w])/gu;
const ETHEREUM = /(?<![\w])0[xX][0-9A-Fa-f]{40}(?![\w])/gu;

function finder(pattern: RegExp): (text: string) => Generator<Span> {
  return function* find(text) {
    const scan = new RegExp(pattern.source, pattern.flags);
    for (let match = scan.exec(text); match !== null; match = scan.exec(text)) {
      yield { start: match.index, end: match.index + match[0].length };
    }
  };
}

const WALLET_WORDS = {
  words: [
    'wallet',
    'address',
    'bitcoin',
    'btc',
    'ethereum',
    'eth',
    'ether',
    'crypto',
    'usdt',
    'usdc',
    'send',
    'pay',
    'deposit',
    'withdraw',
    'metamask',
  ],
  before: 40,
  after: 20,
};

export const BITCOIN_RULE: Rule = {
  id: 'global.crypto.bitcoin',
  type: 'CRYPTO',
  subtype: null,
  country: null,
  find: finder(BITCOIN),
  validate(value) {
    const address = parseCryptoAddress(value);
    if (address === null || address.kind === 'ethereum') return INVALID;
    return finding(BITCOIN_RULE, 'checksum');
  },
  context: WALLET_WORDS,
  contextRequired: false,
  negativeContext: [],
  confidence: { validated: 1, context: 1, none: 1 },
};

export const ETHEREUM_RULE: Rule = {
  id: 'global.crypto.ethereum',
  type: 'CRYPTO',
  subtype: null,
  country: null,
  find: finder(ETHEREUM),
  validate(value, env) {
    const address = parseCryptoAddress(value);
    if (address?.kind !== 'ethereum') return INVALID;
    if (address.casing === 'checksum') {
      return finding(ETHEREUM_RULE, 'checksum');
    }
    return finding(ETHEREUM_RULE, 'none', { possible: !env.hasContext });
  },
  context: WALLET_WORDS,
  contextRequired: false,
  negativeContext: [
    {
      words: [
        'hash',
        'tx',
        'txid',
        'transaction hash',
        'commit',
        'sha',
        'sha1',
        'digest',
        'checksum',
        'fingerprint',
      ],
      before: 24,
      after: 0,
    },
  ],
  confidence: { validated: 1, context: 0.9, none: 0.5 },
};
