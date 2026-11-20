/**
 * CARD stand-ins (TR-S2): the same brand and length, written with the real
 * value's grouping, always a payment processor's published test number (see
 * reserved-values.ts; the detector skips them). Never a random Luhn-valid
 * number: one could be someone's card, which a chatbot's tools or agent
 * mode could then use without a click.
 *
 * When every test number of the brand and length has been tried for a value
 * (the conversation has used them up), the next attempts take published
 * test numbers of the same length from the closest brands (owner, P5.4):
 * the same network family first, then the others. Such a stand-in is marked
 * `fallback` (counted in the dev log). Only when no published test number
 * of that length is left at all is the send blocked with
 * TestCardsExhaustedError.
 */
import {
  cardBrand,
  normaliseCard,
  type CardBrand,
} from '../detect/validators/card.ts';
import { TEST_CARDS } from '../detect/validators/reserved-values.ts';
import { applyLayout } from './layout.ts';
import type { Generator } from './types.ts';

/** Thrown when no published test number of the length is left. */
export class TestCardsExhaustedError extends Error {
  constructor() {
    super('test-cards-exhausted');
    this.name = 'TestCardsExhaustedError';
  }
}

/**
 * Brands to borrow test numbers from, closest first: Maestro is
 * Mastercard's; Discover, Diners Club, JCB, UnionPay and RuPay are accepted
 * on each other's networks (Discover Global Network and its alliances);
 * then the most common brands.
 */
const RELATED: Readonly<Record<CardBrand, readonly CardBrand[]>> = {
  visa: ['mastercard', 'maestro'],
  mastercard: ['maestro', 'visa'],
  maestro: ['mastercard', 'visa'],
  amex: ['visa', 'mastercard'],
  discover: ['diners', 'jcb', 'unionpay', 'rupay'],
  diners: ['discover', 'jcb', 'unionpay', 'rupay'],
  jcb: ['discover', 'diners', 'unionpay', 'rupay'],
  unionpay: ['discover', 'jcb', 'diners', 'rupay'],
  rupay: ['discover', 'diners', 'jcb', 'unionpay'],
};

const ALL_BRANDS = Object.keys(TEST_CARDS) as CardBrand[];

/** Brands other than `brand`, closest first. */
function borrowFrom(brand: CardBrand): CardBrand[] {
  const related = RELATED[brand];
  return [
    ...related,
    ...ALL_BRANDS.filter(
      (other) => other !== brand && !related.includes(other),
    ),
  ];
}

export const cardStandIn: Generator = ({ request, base, attempt }) => {
  const real = normaliseCard(request.value);
  const brand = cardBrand(real);
  if (brand === null) return null;
  const fits = (number: string): boolean =>
    number.length === real.length && number !== real;
  const own = TEST_CARDS[brand].filter(fits);
  if (attempt < own.length) {
    // A different starting point per value, then one number per attempt.
    const number = own[(base.int(own.length) + attempt) % own.length];
    return number === undefined
      ? null
      : { value: applyLayout(request.value, number), reserved: true };
  }
  const borrowed = borrowFrom(brand).flatMap((other) =>
    TEST_CARDS[other].filter(fits),
  );
  const number = borrowed[attempt - own.length];
  if (number === undefined) throw new TestCardsExhaustedError();
  return {
    value: applyLayout(request.value, number),
    reserved: true,
    fallback: true,
  };
};
