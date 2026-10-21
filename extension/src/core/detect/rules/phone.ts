/**
 * Global PHONE rule.
 *
 * The scanner passes on only phone-shaped text: an optional "+", then digit
 * groups joined by single spaces, dots, hyphens or slashes, with optional
 * bracketed groups such as "(0)" or "(020)", 7–15 digits in all. Shapes that
 * are something else are dropped before the (costly) validator runs: dates,
 * year ranges, decimals, version numbers, IPv4 addresses, ISBNs and other
 * values ending in a single check digit, times, prices, and numbers glued to
 * letters or other numbers.
 *
 * Status:
 * - written with "+", or valid in a home region: confirmed;
 * - valid only in other regions: confirmed when grouped or near a phone
 *   context word (the other regions become alternatives), possible when it
 *   is a bare digit run (it may be an order number, but a missed foreign
 *   mobile number would be a silent leak);
 * - negative context ("order", "invoice", "#", ...) drops the candidate
 *   unless a phone context word is also near.
 */
import type { DetectionAlternative } from '../../../shared/entities.ts';
import type { Span } from '../text.ts';
import { validatePhoneSliced } from '../validators/phone.ts';
import { INVALID, finding, type Rule } from './types.ts';

const MIN_DIGITS = 7;
const MAX_DIGITS = 15;
/** Longest bracketed group, e.g. an area code "(02152)". */
const MAX_BRACKETED = 5;

const SEPARATORS = new Set([' ', '.', '-', '/']);
const CURRENCY = new Set([
  '$',
  '€',
  '£',
  '¥',
  '₹',
  '₩',
  '₽',
  '¢',
  '₦',
  '₱',
  '฿',
  '₺',
  '₫',
  '₪',
]);
const OPERATORS = new Set(['=', '*', '×', '÷', '^', '<', '>', '≈', '≤', '≥']);

function isDigit(char: string): boolean {
  return char >= '0' && char <= '9';
}

function isWordChar(char: string): boolean {
  return char !== '' && /^[\p{L}\p{N}_]$/u.test(char);
}

interface Shape {
  span: Span;
  digits: number;
  groups: number[];
  /** Separator after each group but the last; "" between ")" and digits. */
  separators: string[];
  international: boolean;
  bracketed: boolean;
  /** For each group: written in brackets, e.g. "(0)". */
  inBrackets: boolean[];
}

/** False when the character before `at` makes the number part of something else. */
function leftBoundaryOk(text: string, at: number): boolean {
  const prev = text.charAt(at - 1);
  if (prev === '') return true;
  if (isWordChar(prev) || prev === '+' || prev === '#' || prev === '@') {
    return false;
  }
  if (CURRENCY.has(prev) || OPERATORS.has(prev)) return false;
  // "$ 1 234 567", "= 7006652", "2 + 1234567": amounts and arithmetic.
  // ("+" written apart from the digits is never a calling-code prefix.)
  const beforeSpace = text.charAt(at - 2);
  if (
    prev === ' ' &&
    (CURRENCY.has(beforeSpace) ||
      OPERATORS.has(beforeSpace) ||
      beforeSpace === '+')
  ) {
    return false;
  }
  // "3.14…", "v1.2…", "a716-4466…", "12:30…": continuation of a token.
  if ('.,-/:'.includes(prev) && isWordChar(text.charAt(at - 2))) return false;
  return true;
}

/** False when the text after `at` makes the number part of something else. */
function rightBoundaryOk(text: string, at: number): boolean {
  const next = text.charAt(at);
  if (next === '') return true;
  if (isWordChar(next) || next === '%' || next === '@' || next === '+') {
    return false;
  }
  if (CURRENCY.has(next)) return false;
  if (next === ' ' && CURRENCY.has(text.charAt(at + 1))) return false;
  // "1.234.567,89", "12:30", "2024-10-19T…": continuation of a token.
  if ('.,-/:'.includes(next) && isWordChar(text.charAt(at + 1))) return false;
  return true;
}

/** Reads a phone-shaped run starting at `start`, or null. */
function readShape(text: string, start: number): Shape | null {
  let at = start;
  const international = text.charAt(at) === '+';
  if (international) at += 1;
  const groups: number[] = [];
  const separators: string[] = [];
  let digits = 0;
  let bracketed = false;
  const inBrackets: boolean[] = [];
  // End of the last complete group; a separator not followed by one is
  // not part of the number ("0018 (UK)").
  let end = at;
  for (;;) {
    const char = text.charAt(at);
    let length: number;
    if (char === '(') {
      let k = at + 1;
      while (isDigit(text.charAt(k)) && k - at <= MAX_BRACKETED) k += 1;
      length = k - at - 1;
      if (length === 0 || text.charAt(k) !== ')') break;
      bracketed = true;
      at = k + 1;
    } else if (isDigit(char)) {
      let k = at;
      // Bounded: a run longer than any phone number is read to its end
      // once, then rejected as a whole.
      while (isDigit(text.charAt(k))) k += 1;
      length = k - at;
      at = k;
    } else {
      break;
    }
    groups.push(length);
    inBrackets.push(text.charAt(at - 1) === ')');
    digits += length;
    end = at;
    const next = text.charAt(at);
    const after = text.charAt(at + 1);
    if (SEPARATORS.has(next) && (isDigit(after) || after === '(')) {
      separators.push(next);
      at += 1;
    } else if (text.charAt(at - 1) === ')' && isDigit(next)) {
      separators.push('');
    } else {
      break;
    }
  }
  if (groups.length === 0) return null;
  separators.length = groups.length - 1;
  return {
    span: { start, end },
    digits,
    groups,
    separators,
    international,
    bracketed,
    inBrackets,
  };
}

function groupValues(text: string, span: Span): number[] {
  return text
    .slice(span.start, span.end)
    .split(/\D+/u)
    .filter((part) => part.length > 0)
    .map(Number);
}

const isYear = (value: number): boolean => value >= 1900 && value <= 2099;

/** True for a date such as 2024-10-19, 19/10/2024, 19.10.2024 or 20241019. */
function isDate(shape: Shape, values: readonly number[]): boolean {
  const { groups, separators } = shape;
  if (groups.length === 1 && groups[0] === 8 && separators.length === 0) {
    const [value = 0] = values;
    const year = Math.floor(value / 10000);
    const month = Math.floor(value / 100) % 100;
    const day = value % 100;
    return isYear(year) && month >= 1 && month <= 12 && day >= 1 && day <= 31;
  }
  if (groups.length !== 3 || shape.bracketed) return false;
  const [a = 0, b = 0, c = 0] = values;
  const [la = 0, lb = 0, lc = 0] = groups;
  const small = (n: number, length: number) => length <= 2 && n >= 1 && n <= 31;
  if (la === 4 && isYear(a)) return small(b, lb) && small(c, lc);
  if (lc === 4 && isYear(c)) return small(a, la) && small(b, lb);
  return false;
}

/** True for shapes that are not phone numbers, whatever the digits. */
function isOtherNumber(text: string, shape: Shape): boolean {
  const { groups, separators, digits } = shape;
  if (digits < MIN_DIGITS || digits > MAX_DIGITS) return true;
  const values = groupValues(text, shape.span);
  if (isDate(shape, values)) return true;
  // Year ranges: 2019-2024, 2019/2020.
  if (
    groups.length === 2 &&
    groups[0] === 4 &&
    groups[1] === 4 &&
    values.every(isYear) &&
    separators[0] !== ' '
  ) {
    return true;
  }
  // Thousands grouping: 1 234 567, 12.345.678 (a short head, then threes).
  if (
    !shape.international &&
    !shape.bracketed &&
    groups.length >= 3 &&
    (groups[0] ?? 0) <= 2 &&
    groups.slice(1).every((length) => length === 3) &&
    separators.every(
      (sep) => sep === separators[0] && sep !== '-' && sep !== '/',
    )
  ) {
    return true;
  }
  const dots = separators.filter((sep) => sep === '.').length;
  if (dots > 0) {
    // Decimals (3.14159265) and versions (10.0.19045.3693).
    if (groups.length === 2) return true;
    if (groups.slice(1).some((length) => length === 1)) return true;
    // IPv4 addresses.
    if (
      groups.length === 4 &&
      dots === 3 &&
      groups.every((length) => length <= 3) &&
      values.every((value) => value <= 255)
    ) {
      return true;
    }
  }
  // Lists of small numbers (4 8 15 16 23 42), ISBNs, references and other
  // values with a single check digit: no phone number has a one-digit
  // group after the first, except a bracketed trunk prefix such as "(0)".
  if (
    groups.some(
      (length, index) =>
        index > 0 && length === 1 && shape.inBrackets[index] !== true,
    )
  ) {
    return true;
  }
  if (
    digits === 13 &&
    !shape.international &&
    /^97[89]/u.test(values.join(''))
  ) {
    return true;
  }
  return false;
}

/** Phone-shaped candidates, in order. Linear in the text length. */
export function* findPhoneCandidates(text: string): Generator<Span> {
  let at = 0;
  while (at < text.length) {
    const char = text.charAt(at);
    const startsNumber =
      isDigit(char) ||
      ((char === '+' || char === '(') && isDigit(text.charAt(at + 1))) ||
      (char === '+' && text.charAt(at + 1) === '(');
    if (!startsNumber) {
      at += 1;
      continue;
    }
    const shape = leftBoundaryOk(text, at) ? readShape(text, at) : null;
    if (shape === null) {
      // Skip the rest of this token so no candidate starts inside it.
      at += 1;
      while (at < text.length && /[\p{L}\p{N}_+()]/u.test(text.charAt(at))) {
        at += 1;
      }
      continue;
    }
    if (rightBoundaryOk(text, shape.span.end) && !isOtherNumber(text, shape)) {
      yield shape.span;
    }
    at = Math.max(shape.span.end, at + 1);
  }
}

/** No separators, no brackets, no "+": just digits. */
function isBareRun(value: string): boolean {
  return /^\d+$/u.test(value);
}

export const PHONE_RULE: Rule = {
  id: 'global.phone',
  type: 'PHONE',
  subtype: null,
  country: null,
  find: findPhoneCandidates,
  async validate(value, env) {
    const result = await validatePhoneSliced(
      value,
      env.homeRegions,
      env.checkpoint,
    );
    if (!result.valid) return INVALID;
    const [primary, ...others] = result.candidates;
    if (primary === undefined) return INVALID;
    const alternatives: DetectionAlternative[] = others.map((candidate) => ({
      subtype: null,
      country: candidate.country,
      confidence: PHONE_RULE.confidence.none,
    }));
    const foreignBareRun =
      !result.international &&
      !result.fromHomeRegions &&
      isBareRun(value) &&
      !env.hasContext;
    return finding(PHONE_RULE, 'structural', {
      country: primary.country,
      possible: foreignBareRun,
      alternatives,
    });
  },
  context: {
    words: [
      'phone',
      'telephone',
      'tel',
      'mobile',
      'mob',
      'cell',
      'cellphone',
      'call',
      'ring',
      'whatsapp',
      'sms',
      'text me',
      'fax',
      'landline',
      'contact',
      'reach me',
      'handphone',
      'telefon',
      'téléphone',
      'telefone',
      'teléfono',
      'móvil',
      'celular',
      'handy',
      '电话',
      '手机',
    ],
    before: 40,
    after: 16,
  },
  contextRequired: false,
  negativeContext: [
    // A reference number, not a number to call.
    {
      words: [
        'order',
        'invoice',
        'tracking',
        'ref',
        'reference',
        'ticket',
        'booking',
        'confirmation',
        'receipt',
        'transaction',
        'txn',
        'sku',
        'serial',
        'isbn',
        'awb',
        'shipment',
        'parcel',
        'consignment',
        'pnr',
        'claim',
        'policy number',
        'case number',
        'account number',
        'acct',
        'id',
        '#',
        'no.',
        'nº',
        '№',
        'usd',
        'eur',
        'gbp',
        'inr',
        'jpy',
        'cny',
        'rmb',
        'aud',
        'cad',
        'chf',
      ],
      before: 24,
      after: 0,
    },
    // An amount or a quantity.
    {
      words: [
        'usd',
        'eur',
        'gbp',
        'inr',
        'jpy',
        'cny',
        'rmb',
        'aud',
        'cad',
        'chf',
        'timestamp',
        'epoch',
        'seconds',
        'secs',
        'ms',
        'milliseconds',
        'minutes',
        'hours',
        'days',
        'years',
        'km',
        'kg',
        'kb',
        'mb',
        'gb',
        'bytes',
        'rpm',
        'people',
        'users',
        'views',
        'downloads',
        'times',
        'items',
        'rows',
        'words',
        'characters',
      ],
      before: 0,
      after: 16,
    },
  ],
  confidence: { validated: 0.95, context: 0.95, none: 0.85 },
};
