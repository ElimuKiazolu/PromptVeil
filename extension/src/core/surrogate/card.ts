/**
 * CARD stand-ins (TR-S2): the same brand and length, written with the real
 * value's grouping, always a payment processor's published test number (see
 * reserved-values.ts; the detector skips them). Never a random Luhn-valid
 * number: one could be someone's card, which a chatbot's tools or agent
 * mode could then use without a click. When every test number of the brand
 * and length has been tried for a value (the conversation has used them
 * up), the send is blocked with TestCardsExhaustedError.
 */
import { cardBrand, normaliseCard } from '../detect/validators/card.ts';
import { TEST_CARDS } from '../detect/validators/reserved-values.ts';
import { applyLayout } from './layout.ts';
import type { Generator } from './types.ts';

/** Thrown when no published test number of the brand and length is left. */
export class TestCardsExhaustedError extends Error {
  constructor() {
    super('test-cards-exhausted');
    this.name = 'TestCardsExhaustedError';
  }
}

export const cardStandIn: Generator = ({ request, base, attempt }) => {
  const real = normaliseCard(request.value);
  const brand = cardBrand(real);
  if (brand === null) return null;
  const tests = TEST_CARDS[brand].filter(
    (number) => number.length === real.length && number !== real,
  );
  if (attempt >= tests.length) throw new TestCardsExhaustedError();
  // A different starting point per value, then one number per attempt.
  const number = tests[(base.int(tests.length) + attempt) % tests.length];
  return number === undefined
    ? null
    : { value: applyLayout(request.value, number), reserved: true };
};
