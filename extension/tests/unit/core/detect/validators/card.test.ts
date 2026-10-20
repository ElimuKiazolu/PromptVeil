import { describe, expect, it } from 'vitest';
import { luhnCheckDigit } from '@/src/core/detect/checksum.ts';
import {
  cardBrand,
  normaliseCard,
  validateCard,
  type CardBrand,
} from '@/src/core/detect/validators/card.ts';

/** A Luhn-valid number: `payload` plus its check digit. */
const withCheck = (payload: string): string =>
  `${payload}${String(luhnCheckDigit(payload))}`;

// Published test card numbers (Stripe, Adyen, Braintree, Razorpay and
// Cashfree sandbox documentation). None is a real account.
const TEST_CARDS: readonly [CardBrand, string][] = [
  ['visa', '4242424242424242'],
  ['visa', '4111111111111111'],
  ['visa', '4012888888881881'],
  ['visa', '4222222222222'],
  ['visa', '4000056655665556'],
  ['mastercard', '5555555555554444'],
  ['mastercard', '5105105105105100'],
  ['mastercard', '5200828282828210'],
  ['mastercard', '2223003122003222'],
  ['amex', '378282246310005'],
  ['amex', '371449635398431'],
  ['amex', '378734493671000'],
  ['discover', '6011111111111117'],
  ['discover', '6011000990139424'],
  ['jcb', '3530111333300000'],
  ['jcb', '3566002020360505'],
  ['diners', '3056930009020004'],
  ['diners', '36227206271667'],
  ['diners', '30569309025904'],
  ['diners', '38520000023237'],
  ['unionpay', '6200000000000005'],
  ['unionpay', '6200000000000047'],
  ['unionpay', '6205500000000000004'],
  ['maestro', '6304000000000000'],
  ['rupay', '6527658900001005'],
  ['rupay', '6074825972083818'],
  ['rupay', '6528591234543575'],
];

describe('validateCard', () => {
  it.each(TEST_CARDS)('accepts the %s test card %s', (brand, number) => {
    expect(validateCard(number)).toEqual({
      valid: true,
      brand,
      digits: number,
    });
  });

  it('accepts groups separated by single spaces or by single hyphens', () => {
    expect(validateCard('4242 4242 4242 4242')).toMatchObject({
      valid: true,
      brand: 'visa',
    });
    expect(validateCard('4242-4242-4242-4242')).toMatchObject({
      valid: true,
      digits: '4242424242424242',
    });
    expect(validateCard('3782 822463 10005')).toMatchObject({
      valid: true,
      brand: 'amex',
    });
  });

  it('rejects mixed, doubled and leading or trailing separators', () => {
    expect(validateCard('4242 4242-4242 4242').valid).toBe(false);
    expect(validateCard('4242  4242 4242 4242').valid).toBe(false);
    expect(validateCard(' 4242 4242 4242 4242').valid).toBe(false);
    expect(validateCard('4242-4242-4242-4242-').valid).toBe(false);
    expect(validateCard('4242.4242.4242.4242').valid).toBe(false);
  });

  it('rejects numbers failing Luhn', () => {
    expect(validateCard('4242424242424241').valid).toBe(false);
    expect(validateCard('5555555555554440').valid).toBe(false);
    expect(validateCard('378282246310006').valid).toBe(false);
  });

  it('rejects Luhn-valid numbers without a known brand prefix', () => {
    expect(validateCard(withCheck('999999999999999')).valid).toBe(false);
    expect(validateCard(withCheck('100000000000000')).valid).toBe(false);
    // 2221–2720 is Mastercard; 2720 + 1 is not.
    expect(validateCard(withCheck('272100000000000')).valid).toBe(false);
  });

  it('rejects a known prefix at a length the brand does not issue', () => {
    // Amex is 15 digits only; Visa is 13, 16 or 19.
    expect(validateCard(withCheck('378282246310000')).valid).toBe(false);
    expect(validateCard(withCheck('42424242424242')).valid).toBe(false);
  });

  it('rejects lengths outside 13–19 digits, letters and empty input', () => {
    expect(validateCard(withCheck('42424242424')).valid).toBe(false);
    expect(validateCard(withCheck('4'.repeat(19))).valid).toBe(false);
    expect(validateCard('4242424242424242a').valid).toBe(false);
    expect(validateCard('').valid).toBe(false);
  });
});

describe('cardBrand', () => {
  it('prefers the longest matching prefix where ranges overlap', () => {
    // 65 is Discover; 652150–653149 inside it is RuPay.
    expect(cardBrand(withCheck('650000000000000'))).toBe('discover');
    expect(cardBrand(withCheck('652150000000000'))).toBe('rupay');
    expect(cardBrand(withCheck('653150000000000'))).toBe('discover');
    // 62 is UnionPay; 622126–622925 is Discover.
    expect(cardBrand(withCheck('622126000000000'))).toBe('discover');
    expect(cardBrand(withCheck('622927000000000'))).toBe('unionpay');
  });

  it('covers both Mastercard ranges at their edges', () => {
    expect(cardBrand(withCheck('222100000000000'))).toBe('mastercard');
    expect(cardBrand(withCheck('272099999999999'))).toBe('mastercard');
    expect(cardBrand(withCheck('510000000000000'))).toBe('mastercard');
    expect(cardBrand(withCheck('559999999999999'))).toBe('mastercard');
  });
});

describe('normaliseCard', () => {
  it('removes spaces, hyphens, dots and slashes', () => {
    expect(normaliseCard('4242 4242-4242.4242')).toBe('4242424242424242');
    expect(normaliseCard('4242/4242')).toBe('42424242');
  });
});
