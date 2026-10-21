/**
 * Global CARD rule: 13–19 digits, optionally grouped with spaces or hyphens,
 * not part of a longer number, decimal or word. Valid cards (Luhn + brand
 * prefix) are confirmed. A UnionPay number (62, 16–19 digits) that fails Luhn
 * (some UnionPay ranges do not use it) is reported only with a card context
 * word nearby, and only as possible.
 */
import { isDigits } from '../checksum.ts';
import { validateCard } from '../validators/card.ts';
import { stripGroupSeparators } from '../validators/separators.ts';
import { INVALID, finding, type Rule } from './types.ts';

/*
 * Linear: every repetition consumes a digit, the separator is optional and
 * single, and the lookarounds are bounded, so each start position is retried
 * at most 19 times.
 */
const CARD_CANDIDATE =
  /(?<![\p{L}\p{N}_+])(?<!\d[ .,-])\d(?:[ -]?\d){12,18}(?![ -]?\d)(?![\p{L}\p{N}_])(?![.,]\d)/gu;

const UNIONPAY_WITHOUT_LUHN = /^62\d{14,17}$/u;

export const CARD_RULE: Rule = {
  id: 'global.card',
  type: 'CARD',
  subtype: null,
  country: null,
  *find(text) {
    for (const match of text.matchAll(CARD_CANDIDATE)) {
      yield { start: match.index, end: match.index + match[0].length };
    }
  },
  validate(value, env) {
    if (validateCard(value).valid) return finding(CARD_RULE, 'checksum');
    const digits = stripGroupSeparators(value, [' ', '-']);
    if (
      env.hasContext &&
      digits !== null &&
      isDigits(digits) &&
      UNIONPAY_WITHOUT_LUHN.test(digits)
    ) {
      return finding(CARD_RULE, 'none', { possible: true });
    }
    return INVALID;
  },
  context: {
    words: [
      'card',
      'card number',
      'card no',
      'unionpay',
      'union pay',
      '银联',
      '卡号',
    ],
    before: 40,
    after: 16,
  },
  contextRequired: false,
  negativeContext: [],
  confidence: { validated: 1, context: 0.6, none: 0.5 },
};
