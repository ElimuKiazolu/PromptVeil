/**
 * One digit run, several readings across packs and types (TR-R3): context
 * word, then home region, then checksum strength, else "possible".
 *
 * Values: 123456782 (python-stdnum ca.sin example, also a valid SSN shape),
 * 201 555 0143 (NANP 555-01xx fictional range; it also passes the NHS check),
 * 39053344705 (python-stdnum br.cpf example; also a valid phone number in
 * some regions, none of them Brazil).
 */
import { describe, expect, it } from 'vitest';
import type { CountryCode } from '@/src/shared/country.ts';
import type { EntityType } from '@/src/shared/entities.ts';
import { detectRules } from '@/src/core/detect/rules/detector.ts';
import { COUNTRY_PACKS } from '@/src/core/detect/rules/packs/index.ts';
import { isValidRic } from '@/src/core/detect/rules/packs/cn.ts';
import { isValidCpf } from '@/src/core/detect/rules/packs/br.ts';
import { isValidTaxId } from '@/src/core/detect/rules/packs/de.ts';
import { isValidNir } from '@/src/core/detect/rules/packs/fr.ts';
import { isValidAadhaar } from '@/src/core/detect/rules/packs/in.ts';
import { isValidZaId } from '@/src/core/detect/rules/packs/za.ts';
import {
  luhnCheckDigit,
  mod11_10CheckDigit,
  mod11_2CheckCharacter,
} from '@/src/core/detect/checksum.ts';
import { validateCard } from '@/src/core/detect/validators/card.ts';
import { validatePhone } from '@/src/core/detect/validators/phone.ts';

const ALL = new Set<EntityType>([
  'EMAIL',
  'PHONE',
  'CARD',
  'BANK',
  'SECRET',
  'NATIONAL_ID',
]);

const HOMES: Record<string, CountryCode[]> = {
  US: ['US'],
  GB: ['GB'],
  CA: ['CA'],
  BR: ['BR'],
  IN: ['IN'],
  CN: ['CN'],
  SG: ['SG'],
  ZA: ['ZA'],
  ES: ['ES'],
  IT: ['IT'],
  FR: ['FR'],
  DE: ['DE'],
  none: [],
};

type Reading = string;

/** Expected reading per home region set: "TYPE/SUBTYPE status". */
const CASES: {
  name: string;
  text: string;
  value: string;
  /** Per home set; homes not listed expect the "none" result. */
  expected: Partial<Record<keyof typeof HOMES, Reading>> & { none: Reading };
}[] = [
  {
    name: '9 digits: US_SSN vs CA_SIN vs PHONE, both ID words present',
    text: 'SSN or SIN: 123456782',
    value: '123456782',
    expected: {
      US: 'NATIONAL_ID/US_SSN confirmed',
      CA: 'NATIONAL_ID/CA_SIN confirmed',
      GB: 'NATIONAL_ID/CA_SIN confirmed',
      BR: 'NATIONAL_ID/CA_SIN confirmed',
      IN: 'NATIONAL_ID/CA_SIN confirmed',
      none: 'NATIONAL_ID/CA_SIN confirmed',
    },
  },
  {
    name: '9 digits with only a SIN word',
    text: 'my NAS 123456782',
    value: '123456782',
    expected: {
      US: 'NATIONAL_ID/CA_SIN confirmed',
      CA: 'NATIONAL_ID/CA_SIN confirmed',
      GB: 'NATIONAL_ID/CA_SIN confirmed',
      BR: 'NATIONAL_ID/CA_SIN confirmed',
      IN: 'NATIONAL_ID/CA_SIN confirmed',
      none: 'NATIONAL_ID/CA_SIN confirmed',
    },
  },
  {
    // 536-90-4399 is the python-stdnum us.ssn example (Luhn-invalid, so no SIN).
    // Both readings are personal data and have their own context word:
    // masked either way (sensitive-either-way rule); the order picks the kind.
    // Home CA counts the US reading as home (shared +1 calling code).
    name: '9 digits: US_SSN vs PHONE, both words, no checksum: confirmed either way',
    text: 'SSN or phone: 536904399',
    value: '536904399',
    expected: {
      US: 'NATIONAL_ID/US_SSN confirmed',
      CA: 'NATIONAL_ID/US_SSN confirmed',
      GB: 'PHONE/- confirmed',
      BR: 'PHONE/- confirmed',
      IN: 'PHONE/- confirmed',
      none: 'PHONE/- confirmed',
    },
  },
  {
    // A NANP number is near-home for CA (shared +1).
    name: '10 digits: UK_NHS vs PHONE, no context word',
    text: 'Number: 201 555 0143.',
    value: '201 555 0143',
    expected: {
      US: 'PHONE/- confirmed',
      CA: 'PHONE/- confirmed',
      // Also a valid Chinese landline (area code 20) when CN is home.
      CN: 'PHONE/- confirmed',
      GB: 'NATIONAL_ID/UK_NHS confirmed',
      BR: 'NATIONAL_ID/UK_NHS confirmed',
      IN: 'NATIONAL_ID/UK_NHS confirmed',
      none: 'NATIONAL_ID/UK_NHS confirmed',
    },
  },
  {
    name: '10 digits with a phone word',
    text: 'Call 201 555 0143 today',
    value: '201 555 0143',
    expected: {
      US: 'PHONE/- confirmed',
      CA: 'PHONE/- confirmed',
      GB: 'PHONE/- confirmed',
      BR: 'PHONE/- confirmed',
      IN: 'PHONE/- confirmed',
      none: 'PHONE/- confirmed',
    },
  },
  {
    name: '10 digits with an NHS word',
    text: 'NHS 201 555 0143',
    value: '201 555 0143',
    expected: {
      US: 'NATIONAL_ID/UK_NHS confirmed',
      CA: 'NATIONAL_ID/UK_NHS confirmed',
      GB: 'NATIONAL_ID/UK_NHS confirmed',
      BR: 'NATIONAL_ID/UK_NHS confirmed',
      IN: 'NATIONAL_ID/UK_NHS confirmed',
      none: 'NATIONAL_ID/UK_NHS confirmed',
    },
  },
  {
    name: '11 digits: BR_CPF vs PHONE, no context word',
    text: 'Documento 39053344705',
    value: '39053344705',
    expected: {
      // An Italian mobile number (3xx) with home IT; Italy's cells are not permissive.
      IT: 'PHONE/- confirmed',
      US: 'NATIONAL_ID/BR_CPF confirmed',
      CA: 'NATIONAL_ID/BR_CPF confirmed',
      GB: 'NATIONAL_ID/BR_CPF confirmed',
      BR: 'NATIONAL_ID/BR_CPF confirmed',
      IN: 'NATIONAL_ID/BR_CPF confirmed',
      none: 'NATIONAL_ID/BR_CPF confirmed',
    },
  },
  {
    name: '11 digits with a phone word',
    text: 'phone 39053344705',
    value: '39053344705',
    expected: {
      US: 'PHONE/- confirmed',
      CA: 'PHONE/- confirmed',
      GB: 'PHONE/- confirmed',
      BR: 'PHONE/- confirmed',
      IN: 'PHONE/- confirmed',
      none: 'PHONE/- confirmed',
    },
  },
];

describe('cross-pack and cross-type ambiguity (TR-R3)', () => {
  for (const testCase of CASES) {
    describe(testCase.name, () => {
      it.each(Object.keys(HOMES))('home %s', async (home) => {
        const detections = await detectRules(testCase.text, {
          homeRegions: HOMES[home] ?? [],
          entityTypes: ALL,
          packs: COUNTRY_PACKS,
          exclude: [],
        });
        expect(detections).toHaveLength(1);
        const [detection] = detections;
        expect(detection?.value).toBe(testCase.value);
        expect(
          `${detection?.type ?? ''}/${detection?.subtype ?? '-'} ${detection?.status ?? ''}`,
        ).toBe(testCase.expected[home] ?? testCase.expected.none);
        // The losing readings are kept as alternatives, with their type.
        expect(detection?.alternatives.length).toBeGreaterThan(0);
      });
    });
  }
});

/** Fixed linear congruential sequence: the same numbers on every run. */
function seeded(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };
}

function digitsFrom(next: () => number, count: number): string {
  let out = '';
  for (let i = 0; i < count; i += 1) out += Math.floor(next() * 10).toString();
  return out;
}

/** The first generated value (in memory only) that satisfies `accept`. */
function firstGenerated(
  seed: number,
  make: (next: () => number) => string,
  accept: (value: string) => boolean,
): string {
  const next = seeded(seed);
  for (let tries = 0; tries < 200_000; tries += 1) {
    const value = make(next);
    if (accept(value)) return value;
  }
  throw new Error('no value found');
}

const group4 = (digits: string): string =>
  digits.replace(/(\d{4})(?=\d)/gu, '$1 ');

/**
 * Values that read validly as two kinds at once, generated at test time
 * (test-data policy: never written to the repository).
 */
const indianNumber = firstGenerated(
  701,
  (next) => `919${digitsFrom(next, 9)}`,
  (value) => {
    if (!isValidAadhaar(value)) return false;
    const phone = validatePhone(value, ['IN']);
    return phone.valid && phone.fromHomeRegions;
  },
);
const zaAndCard = firstGenerated(
  702,
  (next) => {
    const payload = `4${digitsFrom(next, 1)}0${(1 + Math.floor(next() * 9)).toString()}1${digitsFrom(next, 1)}${digitsFrom(next, 4)}0${digitsFrom(next, 1)}`;
    return `${payload}${String(luhnCheckDigit(payload))}`;
  },
  (value) => isValidZaId(value) && validateCard(value).valid,
);
const ricAndCard = firstGenerated(
  703,
  (next) => {
    const payload = `620102198${digitsFrom(next, 1)}0${(1 + Math.floor(next() * 9)).toString()}1${digitsFrom(next, 1)}${digitsFrom(next, 3)}`;
    return `${payload}${mod11_2CheckCharacter(payload) ?? ''}`;
  },
  (value) => isValidRic(value) && validateCard(value).valid,
);

const taxIdAndCpf = firstGenerated(
  704,
  (next) => {
    const pool = '0123456789'.split('').sort(() => next() - 0.5);
    const digits = pool.slice(0, 9);
    digits.push(digits[Math.floor(next() * 9)] ?? '1');
    const first10 = digits.sort(() => next() - 0.5).join('');
    return `${first10}${String(mod11_10CheckDigit(first10))}`;
  },
  (value) => isValidTaxId(value) && isValidCpf(value),
);
const nirAndAmex = firstGenerated(
  705,
  (next) => {
    const payload = `37${digitsFrom(next, 1)}0${(1 + Math.floor(next() * 9)).toString()}${(1 + Math.floor(next() * 9)).toString().padStart(2, '0')}${digitsFrom(next, 7)}`;
    return `${payload}${String(luhnCheckDigit(payload))}`;
  },
  (value) => isValidNir(value) && validateCard(value).valid,
);

const GENERATED: {
  name: string;
  text: string;
  value: string;
  expected: Partial<Record<keyof typeof HOMES, Reading>> & { none: Reading };
  /** Only one reading survives (the other needs a context word). */
  single?: boolean;
}[] = [
  {
    name: '12 digits: IN_AADHAAR vs an Indian phone written 91 + mobile, Aadhaar word',
    text: `Aadhaar ${indianNumber}`,
    value: indianNumber,
    expected: { none: 'NATIONAL_ID/IN_AADHAAR confirmed' },
  },
  {
    name: '12 digits: the same run with a phone word (plain Aadhaar needs its own word)',
    text: `call ${indianNumber}`,
    value: indianNumber,
    expected: { none: 'PHONE/- confirmed' },
    single: true,
  },
  {
    name: '12 digits written 4-4-4, no word: the Aadhaar checksum wins',
    text: `Number: ${group4(indianNumber)}`,
    value: group4(indianNumber),
    expected: {
      none: 'NATIONAL_ID/IN_AADHAAR confirmed',
    },
  },
  {
    name: '13 digits: ZA_ID vs a 13-digit Visa number, no word',
    text: `Number: ${zaAndCard}`,
    value: zaAndCard,
    expected: {
      ZA: 'NATIONAL_ID/ZA_ID confirmed',
      none: 'CARD/- confirmed',
    },
  },
  {
    name: '13 digits with an ID word',
    text: `ID number ${zaAndCard}`,
    value: zaAndCard,
    expected: { none: 'NATIONAL_ID/ZA_ID confirmed' },
  },
  {
    name: '18 digits: CN_RIC vs an 18-digit card number, no word',
    text: `Number: ${ricAndCard}`,
    value: ricAndCard,
    expected: { CN: 'NATIONAL_ID/CN_RIC confirmed', none: 'CARD/- confirmed' },
  },
  {
    name: '18 digits with an ID card word',
    text: `身份证号 ${ricAndCard}`,
    value: ricAndCard,
    expected: { none: 'NATIONAL_ID/CN_RIC confirmed' },
  },
  {
    name: '11 digits: DE_TAXID vs BR_CPF (and PHONE), no word',
    text: `Number: ${taxIdAndCpf}`,
    value: taxIdAndCpf,
    expected: {
      DE: 'NATIONAL_ID/DE_TAXID confirmed',
      none: 'NATIONAL_ID/BR_CPF confirmed',
    },
  },
  {
    name: '11 digits with a Steuer-ID word',
    text: `Steuer-ID ${taxIdAndCpf}`,
    value: taxIdAndCpf,
    expected: { none: 'NATIONAL_ID/DE_TAXID confirmed' },
  },
  {
    name: '11 digits with a CPF word',
    text: `CPF ${taxIdAndCpf}`,
    value: taxIdAndCpf,
    expected: { none: 'NATIONAL_ID/BR_CPF confirmed' },
  },
  {
    name: '15 digits: FR_NIR vs an Amex-shaped card number, no word',
    text: `Number: ${nirAndAmex}`,
    value: nirAndAmex,
    expected: {
      FR: 'NATIONAL_ID/FR_NIR confirmed',
      none: 'CARD/- confirmed',
    },
  },
  {
    name: '15 digits with a social security word',
    text: `Numéro de sécurité sociale ${nirAndAmex}`,
    value: nirAndAmex,
    expected: { none: 'NATIONAL_ID/FR_NIR confirmed' },
  },
  {
    name: '15 digits with a card word',
    text: `card number ${nirAndAmex}`,
    value: nirAndAmex,
    expected: { none: 'CARD/- confirmed' },
  },
];

describe('ambiguity with the IN, CN, SG and ZA packs (generated values)', () => {
  for (const testCase of GENERATED) {
    describe(testCase.name, () => {
      it.each(Object.keys(HOMES))('home %s', async (home) => {
        const detections = await detectRules(testCase.text, {
          homeRegions: HOMES[home] ?? [],
          entityTypes: ALL,
          packs: COUNTRY_PACKS,
          exclude: [],
        });
        expect(detections).toHaveLength(1);
        const [detection] = detections;
        expect(detection?.value).toBe(testCase.value);
        expect(
          `${detection?.type ?? ''}/${detection?.subtype ?? '-'} ${detection?.status ?? ''}`,
        ).toBe(testCase.expected[home] ?? testCase.expected.none);
        if (testCase.single !== true) {
          expect(detection?.alternatives.length).toBeGreaterThan(0);
        }
      });
    });
  }
});
