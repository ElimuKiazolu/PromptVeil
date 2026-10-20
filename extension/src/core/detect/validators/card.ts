/**
 * CARD validation: 13–19 digits, optionally grouped with spaces or hyphens,
 * passing Luhn and starting with a known brand's prefix at a length that
 * brand issues.
 *
 * Prefix ranges follow the networks' published IIN tables. Where ranges
 * overlap, the longest matching prefix wins (e.g. RuPay's 652150–653149 inside
 * Discover's 65). Cards that skip Luhn (some UnionPay ranges) are not
 * accepted: Luhn is what keeps arbitrary 16-digit numbers from matching.
 */
import { isDigits, isValidLuhn } from '../checksum.ts';
import { removeNumericSeparators, stripGroupSeparators } from './separators.ts';

export type CardBrand =
  | 'visa'
  | 'mastercard'
  | 'amex'
  | 'discover'
  | 'jcb'
  | 'diners'
  | 'unionpay'
  | 'maestro'
  | 'rupay';

export type CardValidation =
  { valid: true; brand: CardBrand; digits: string } | { valid: false };

interface PrefixRange {
  brand: CardBrand;
  /** Inclusive range of prefixes with the same number of digits. */
  from: string;
  to: string;
  lengths: readonly number[];
}

const MIN_LENGTH = 13;
const MAX_LENGTH = 19;

const range = (
  brand: CardBrand,
  from: string,
  to: string,
  lengths: readonly number[],
): PrefixRange => ({ brand, from, to, lengths });

const SIXTEEN_TO_NINETEEN = [16, 17, 18, 19];

const RANGES: readonly PrefixRange[] = [
  range('visa', '4', '4', [13, 16, 19]),
  range('mastercard', '51', '55', [16]),
  range('mastercard', '2221', '2720', [16]),
  range('amex', '34', '34', [15]),
  range('amex', '37', '37', [15]),
  range('discover', '6011', '6011', SIXTEEN_TO_NINETEEN),
  range('discover', '644', '649', SIXTEEN_TO_NINETEEN),
  range('discover', '65', '65', SIXTEEN_TO_NINETEEN),
  range('discover', '622126', '622925', SIXTEEN_TO_NINETEEN),
  range('jcb', '3528', '3589', SIXTEEN_TO_NINETEEN),
  range('diners', '300', '305', [14, 15, 16, 17, 18, 19]),
  range('diners', '3095', '3095', [14, 15, 16, 17, 18, 19]),
  range('diners', '36', '36', [14, 15, 16, 17, 18, 19]),
  range('diners', '38', '39', [14, 15, 16, 17, 18, 19]),
  range('unionpay', '62', '62', SIXTEEN_TO_NINETEEN),
  range('unionpay', '8100', '8171', SIXTEEN_TO_NINETEEN),
  range('maestro', '5018', '5018', [13, 14, 15, 16, 17, 18, 19]),
  range('maestro', '5020', '5020', [13, 14, 15, 16, 17, 18, 19]),
  range('maestro', '5038', '5038', [13, 14, 15, 16, 17, 18, 19]),
  range('maestro', '5893', '5893', [13, 14, 15, 16, 17, 18, 19]),
  range('maestro', '6304', '6304', [13, 14, 15, 16, 17, 18, 19]),
  range('maestro', '6759', '6759', [13, 14, 15, 16, 17, 18, 19]),
  range('maestro', '6761', '6763', [13, 14, 15, 16, 17, 18, 19]),
  range('rupay', '60', '60', [16]),
  range('rupay', '508', '508', [16]),
  range('rupay', '652150', '653149', [16]),
  range('rupay', '81', '82', [16]),
];

/** Brand of a digit string by longest matching prefix at a valid length. */
export function cardBrand(digits: string): CardBrand | null {
  let best: PrefixRange | null = null;
  for (const candidate of RANGES) {
    const prefix = digits.slice(0, candidate.from.length);
    if (prefix.length < candidate.from.length) continue;
    if (prefix < candidate.from || prefix > candidate.to) continue;
    if (!candidate.lengths.includes(digits.length)) continue;
    if (best === null || candidate.from.length > best.from.length) {
      best = candidate;
    }
  }
  return best?.brand ?? null;
}

export function validateCard(value: string): CardValidation {
  const digits = stripGroupSeparators(value, [' ', '-']);
  if (digits === null || !isDigits(digits)) return { valid: false };
  if (digits.length < MIN_LENGTH || digits.length > MAX_LENGTH) {
    return { valid: false };
  }
  if (!isValidLuhn(digits)) return { valid: false };
  const brand = cardBrand(digits);
  return brand === null ? { valid: false } : { valid: true, brand, digits };
}

/** Vault form: digits only. */
export function normaliseCard(value: string): string {
  return removeNumericSeparators(value);
}
