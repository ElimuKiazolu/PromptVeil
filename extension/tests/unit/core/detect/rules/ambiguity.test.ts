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
  none: [],
};

type Reading = string;

/** Expected reading per home region set: "TYPE/SUBTYPE status". */
const CASES: {
  name: string;
  text: string;
  value: string;
  expected: Record<keyof typeof HOMES, Reading>;
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
    name: '9 digits: US_SSN vs PHONE, both words, no checksum: possible unless home decides',
    text: 'SSN or phone: 536904399',
    value: '536904399',
    expected: {
      US: 'NATIONAL_ID/US_SSN confirmed',
      CA: 'PHONE/- possible',
      GB: 'PHONE/- possible',
      BR: 'PHONE/- possible',
      IN: 'PHONE/- possible',
      none: 'PHONE/- possible',
    },
  },
  {
    name: '10 digits: UK_NHS vs PHONE, no context word',
    text: 'Number: 201 555 0143.',
    value: '201 555 0143',
    expected: {
      US: 'PHONE/- confirmed',
      CA: 'NATIONAL_ID/UK_NHS confirmed',
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
        ).toBe(testCase.expected[home]);
        // The losing readings are kept as alternatives, with their type.
        expect(detection?.alternatives.length).toBeGreaterThan(0);
      });
    });
  }
});
