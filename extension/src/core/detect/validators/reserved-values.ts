/**
 * Published test and example values: they belong to no one, so the detector
 * does not report them, and the stand-in engine uses them first (a stand-in
 * taken from here is never detected as a real value again). The NHS test
 * range lives with the NHS validator (gb.ts) and fictional phone ranges in
 * fictional-phones.ts.
 *
 * Sources:
 * - Cards: Stripe, "Testing" (docs.stripe.com/testing): numbers that work
 *   only in test mode. Only these exact numbers are skipped; any other number
 *   on the same prefix is a card like any other.
 * - AWS access key IDs: the example IDs of AWS's documentation, e.g. IAM
 *   User Guide, "How an IAM administrator can manage IAM user access keys"
 *   (docs.aws.amazon.com/IAM/latest/UserGuide/access-keys-admin-managed.html:
 *   AKIAIOSFODNN7EXAMPLE and AKIAI44QH8DHBEXAMPLE) and the SDKs and Tools
 *   Reference Guide, "AWS access keys" (docs.aws.amazon.com/sdkref/latest/
 *   guide/feature-static-credentials.html: AKIAIOSFODNN7EXAMPLE).
 */
import type { CardBrand } from './card.ts';

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

const TEST_CARD_SET: ReadonlySet<string> = new Set(
  Object.values(TEST_CARDS).flat(),
);

/** True for a published test card number (digits only). */
export function isTestCard(digits: string): boolean {
  return TEST_CARD_SET.has(digits);
}

/** AWS's documented example access key IDs. */
export const AWS_EXAMPLE_ACCESS_KEY_IDS: readonly string[] = [
  'AKIAIOSFODNN7EXAMPLE',
  'AKIAI44QH8DHBEXAMPLE',
];

/** True for a documented example credential (not anyone's secret). */
export function isDocumentedExampleKey(value: string): boolean {
  return AWS_EXAMPLE_ACCESS_KEY_IDS.includes(value.trim());
}
