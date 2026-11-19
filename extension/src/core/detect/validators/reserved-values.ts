/**
 * Published test and example values: they belong to no one, so the detector
 * does not report them, and the stand-in engine uses them first (a stand-in
 * taken from here is never detected as a real value again). The NHS test
 * range lives with the NHS validator (gb.ts) and fictional phone ranges in
 * fictional-phones.ts.
 *
 * Sources:
 * - Cards: payment processors' published test numbers (sources below).
 *   Only these exact numbers are skipped; any other number on the same
 *   prefix is a card like any other.
 * - AWS access key IDs: the example IDs of AWS's documentation, e.g. IAM
 *   User Guide, "How an IAM administrator can manage IAM user access keys"
 *   (docs.aws.amazon.com/IAM/latest/UserGuide/access-keys-admin-managed.html:
 *   AKIAIOSFODNN7EXAMPLE and AKIAI44QH8DHBEXAMPLE) and the SDKs and Tools
 *   Reference Guide, "AWS access keys" (docs.aws.amazon.com/sdkref/latest/
 *   guide/feature-static-credentials.html: AKIAIOSFODNN7EXAMPLE).
 */
import { cardBrand, type CardBrand } from './card.ts';

/**
 * Published test card numbers: they work only in a payment processor's test
 * mode, so a stand-in taken from here can never charge or pay anyone. Card
 * stand-ins come only from this list (never a random Luhn-valid number).
 * Copied from each page (2026-11-18):
 * - Stripe, "Testing": docs.stripe.com/testing
 * - Adyen, "Test card numbers": docs.adyen.com/development-resources/
 *   test-cards-and-credentials/test-card-numbers/
 * - Braintree, "Testing and Go Live": developer.paypal.com/braintree/docs/
 *   guides/credit-cards/testing-go-live/
 * - Checkout.com, "Test cards": www.checkout.com/docs/developer-resources/
 *   testing/test-cards
 * - Razorpay, "Test Card Details": razorpay.com/docs/payments/payments/
 *   test-card-details/
 * Left out: 4111 1111 1111 1111 and 3700 0000 0000 002 (also published,
 * by Braintree and Adyen), which the tests use as real-looking card numbers
 * that must stay detectable; and numbers whose prefix the card rule does
 * not read as any brand (never detected, so never needed as stand-ins).
 */
const PUBLISHED_TEST_CARDS: Readonly<Record<string, readonly string[]>> = {
  stripe: [
    '4242424242424242',
    '4000056655665556',
    '4000002500000003',
    '4000002760000016',
    '4000008260000000',
    '4000003560000008',
    '4000000760000002',
    '4000001240000000',
    '5555555555554444',
    '2223003122003222',
    '5200828282828210',
    '5105105105105100',
    '378282246310005',
    '371449635398431',
    '6011111111111117',
    '6011000990139424',
    '6011981111111113',
    '3056930009020004',
    '36227206271667',
    '3566002020360505',
    '3530111333300000',
    '6200000000000005',
    '6200000000000047',
    '6205500000000000004',
  ],
  adyen: [
    '4111111145551142',
    '4111112014267661',
    '4988438843884305',
    '4166676667666746',
    '4646464646464644',
    '4000620000000007',
    '4000060000000006',
    '4293189100000008',
    '4988080000000000',
    '4444333322221111',
    '4001590000000001',
    '4000180000000002',
    '4000020000000000',
    '4000160000000004',
    '4002690000000008',
    '4400000000000008',
    '4484600000000004',
    '4607000000000009',
    '4977949494949497',
    '4000640000000005',
    '4003550000000003',
    '4000760000000001',
    '4005519000000006',
    '4131840000000003',
    '4151500000000008',
    '4199350000000002',
    '4917610000000000',
    '4001020000000009',
    '4400002000000004',
    '4000033003300335',
    '2222400070000005',
    '5555341244441115',
    '5577000055770004',
    '5555444433331111',
    '2222410740360010',
    '2222410700000002',
    '2222400010000008',
    '2223000048410010',
    '5130290000000009',
    '2222400060000007',
    '2223520443560010',
    '2222400030000004',
    '5100060000000002',
    '2222400050000009',
    '5103221911199245',
    '5454545454545454',
    '5413330033003303',
    '370000000100018',
    '36006666333344',
    '36070500001020',
    '30569309025904',
    '6011601160116611',
    '6445644564456445',
    '6011609900000003',
    '6445645000000002',
    '3569990010095841',
    '3566111111111113',
    '6243030000000001',
    '6250947000000014',
    '6250946000000016',
  ],
  braintree: [
    '36259600000004',
    '38520000009814',
    '6011000991300009',
    '6221261111117766',
    '6223164991230014',
    '6304000000000000',
    '2223000048400011',
    '5101108206957373',
    '4005519200000004',
    '4009348888881881',
    '4012000033330026',
    '4012000077777777',
    '4012888888881881',
    '4217651111111119',
    '4500600000000061',
    '4000111111111115',
    '4012000033330620',
    '4012000033330729',
    '4023490000000008',
    '4012000033330521',
    '4012004338508385',
    '4009040000000009',
    '4012000033330125',
    '4012000033330224',
    '4012000033330422',
    '4012000033330323',
    '378734493671000',
    '374512431123241',
    '375529658790105',
  ],
  checkout: [
    '4273149019799094',
    '4539467987109256',
    '4024007181869214',
    '4916301720257093',
    '4485899805156040',
    '4659105569051157',
    '4010061700000021',
    '4485040371536584',
    '4539628347117863',
    '4024007186645015',
    '4556574722325580',
    '4275765574319271',
    '4484070000035519',
    '4452927588210665',
    '4556085951507152',
    '4152868552773614',
    '4243754271700719',
    '4447336775378848',
    '4539929207120660',
    '4485597929486000',
    '4532432452900131',
    '5436031030606378',
    '5585076576791786',
    '5305484748800098',
    '5588686116426417',
    '5309961755464047',
    '5234106378657904',
    '5558468902774508',
    '5596061690670931',
    '5352151570003404',
    '5291144083573579',
    '5121073611487018',
    '5385308360135181',
    '5518832400606463',
    '5258901507741160',
    '5569757734785691',
    '5572408422189334',
    '5259410220714099',
    '345678901234564',
    '341829238058580',
    '371064645462927',
    '344282679519362',
    '343397288296672',
    '378702153281139',
    '340282533032846',
    '372688581899681',
    '346126139326850',
    '375982239796002',
    '347411540178242',
    '377990956548835',
    '372310461284948',
    '36160940933914',
    '36160912071610',
    '36747880216043',
    '36138956596288',
    '3528982710432481',
    '3528682570029332',
    '3582069482684995',
    '3528257085901927',
    '3566027046765007',
    '6011201559638046790',
    '6445979375892355607',
    '6224120000000094',
    '6224120000000086',
    '6224120000000078',
    '6224120000000029',
    '6224120000000011',
    '6224120000000110',
    '6224120000000003',
    '6224120000000060',
    '6224120000000052',
    '6224120000000045',
    '6224120000000037',
    '6224120000000128',
  ],
  razorpay: [
    '4100280000001007',
    '4718609108204366',
    '5555510000081006',
    '5180287200091001',
    '5104015555555558',
    '5104060000000008',
    '5241810000000000',
    '6527658900001005',
    '36082800091007',
    '340256000401007',
  ],
};

/**
 * The published test numbers by the brand the card rule reads (the longest
 * matching prefix decides, so e.g. a co-branded UnionPay number may count
 * as Discover), each once.
 */
export const TEST_CARDS: Readonly<Record<CardBrand, readonly string[]>> =
  (() => {
    const out: Record<CardBrand, string[]> = {
      visa: [],
      mastercard: [],
      amex: [],
      discover: [],
      diners: [],
      jcb: [],
      unionpay: [],
      maestro: [],
      rupay: [],
    };
    const seen = new Set<string>();
    for (const numbers of Object.values(PUBLISHED_TEST_CARDS)) {
      for (const number of numbers) {
        const brand = cardBrand(number);
        if (brand === null || seen.has(number)) continue;
        seen.add(number);
        out[brand].push(number);
      }
    }
    return out;
  })();

/** Every listed number, for the check that each is a valid card. */
export const PUBLISHED_TEST_CARD_NUMBERS: readonly string[] =
  Object.values(PUBLISHED_TEST_CARDS).flat();

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
