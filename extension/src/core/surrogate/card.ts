/**
 * CARD stand-ins (TR-S2): the same brand and length, Luhn-valid, written
 * with the real value's grouping. The first attempts use published test
 * card numbers of that brand and length (Stripe, "Testing", docs.stripe.com/
 * testing: numbers that only work in test mode); after that, or when no test
 * number has the length, a random number with a prefix (IIN) of the brand.
 */
import { luhnCheckDigit } from '../detect/checksum.ts';
import {
  CARD_PREFIX_RANGES,
  cardBrand,
  normaliseCard,
  type CardBrand,
} from '../detect/validators/card.ts';
import { applyLayout } from './layout.ts';
import { DIGITS } from './rng.ts';
import type { Generator } from './types.ts';

/** Stripe test card numbers, by brand. */
export const TEST_CARDS: Readonly<Record<CardBrand, readonly string[]>> = {
  visa: [
    '4242424242424242',
    '4000056655665556',
    '4000002500000003',
    '4000002760000016',
    '4000008260000000',
    '4000003560000008',
    '4000000760000002',
    '4000001240000000',
  ],
  mastercard: [
    '5555555555554444',
    '2223003122003222',
    '5200828282828210',
    '5105105105105100',
  ],
  amex: ['378282246310005', '371449635398431'],
  discover: ['6011111111111117', '6011000990139424', '6011981111111113'],
  diners: ['3056930009020004', '36227206271667'],
  jcb: ['3566002020360505', '3530111333300000'],
  unionpay: ['6200000000000005', '6200000000000047', '6205500000000000004'],
  maestro: [],
  rupay: [],
};

const RANDOM_DRAWS = 64;

export const cardStandIn: Generator = ({
  request,
  rng,
  base,
  attempt,
  reservedAllowed,
}) => {
  const real = normaliseCard(request.value);
  const brand = cardBrand(real);
  if (brand === null) return null;
  const tests = TEST_CARDS[brand].filter(
    (number) => number.length === real.length && number !== real,
  );
  if (reservedAllowed && attempt < tests.length) {
    // A different starting point per value, then one number per attempt.
    const start = base.int(tests.length);
    const number = tests[(start + attempt) % tests.length];
    if (number !== undefined) {
      return { value: applyLayout(request.value, number), reserved: true };
    }
  }
  const ranges = CARD_PREFIX_RANGES.filter(
    (range) => range.brand === brand && range.lengths.includes(real.length),
  );
  if (ranges.length === 0) return null;
  for (let draw = 0; draw < RANDOM_DRAWS; draw += 1) {
    const range = rng.pick(ranges);
    const prefix = rng
      .between(Number(range.from), Number(range.to))
      .toString()
      .padStart(range.from.length, '0');
    const payload = prefix + rng.chars(DIGITS, real.length - prefix.length - 1);
    const check = luhnCheckDigit(payload);
    if (check === null) continue;
    const number = payload + check.toString();
    // The longest-prefix rule may give the number another brand.
    if (number !== real && cardBrand(number) === brand) {
      return { value: applyLayout(request.value, number), reserved: false };
    }
  }
  return null;
};
