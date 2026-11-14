/**
 * CARD stand-ins (TR-S2): the same brand and length, Luhn-valid, written
 * with the real value's grouping. The first attempts use published test
 * card numbers of that brand and length (see reserved-values.ts; the
 * detector skips them); after that, or when no test number has the length,
 * a random number with a prefix (IIN) of the brand.
 */
import { luhnCheckDigit } from '../detect/checksum.ts';
import {
  CARD_PREFIX_RANGES,
  cardBrand,
  normaliseCard,
} from '../detect/validators/card.ts';
import { TEST_CARDS } from '../detect/validators/reserved-values.ts';
import { applyLayout } from './layout.ts';
import { DIGITS } from './rng.ts';
import type { Generator } from './types.ts';

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
