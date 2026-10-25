/**
 * Words that mark a number as something other than personal data, shared by
 * the rules for bare digit runs (phone numbers, national IDs).
 */
import type { ContextWords } from './types.ts';

/** A reference or record number: order, invoice, ticket, ... */
export const REFERENCE_WORDS: readonly string[] = [
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
];

/** An amount of money. */
export const CURRENCY_CODES: readonly string[] = [
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
];

/** A quantity or a measurement. */
export const UNIT_WORDS: readonly string[] = [
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
];

/** Reference words or a currency code just before the number. */
export const REFERENCE_BEFORE: ContextWords = {
  words: [...REFERENCE_WORDS, ...CURRENCY_CODES],
  before: 24,
  after: 0,
};

/** A currency code or a unit just after the number. */
export const QUANTITY_AFTER: ContextWords = {
  words: [...CURRENCY_CODES, ...UNIT_WORDS],
  before: 0,
  after: 16,
};

/**
 * Words that label an identity number rather than a reference ("ID 3604…",
 * "ID no. 7503…"); they must not veto national IDs.
 */
const ID_LABELS = new Set(['id', 'no.', 'nº', '№']);

/** Reference words and currency codes before a national ID candidate. */
export const ID_REFERENCE_BEFORE: ContextWords = {
  words: [...REFERENCE_WORDS, ...CURRENCY_CODES].filter(
    (word) => !ID_LABELS.has(word),
  ),
  before: 24,
  after: 0,
};
