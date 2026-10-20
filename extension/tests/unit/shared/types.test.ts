import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  COUNTRY_CODES,
  isCountryCode,
  type CountryCode,
} from '@/src/shared/country.ts';
import {
  ENTITY_TYPES,
  type Detection,
  type NationalIdSubtype,
} from '@/src/shared/entities.ts';
import { DEFAULT_SETTINGS, type Settings } from '@/src/shared/settings.ts';

describe('country codes', () => {
  it('lists the 249 ISO 3166-1 alpha-2 codes plus XK, sorted and unique', () => {
    expect(COUNTRY_CODES).toHaveLength(250);
    expect(new Set(COUNTRY_CODES).size).toBe(250);
    expect([...COUNTRY_CODES].sort()).toEqual([...COUNTRY_CODES]);
    expect(COUNTRY_CODES.every((code) => /^[A-Z]{2}$/.test(code))).toBe(true);
    expect(COUNTRY_CODES).toContain('XK');
  });

  it('recognises only upper-case assigned codes', () => {
    expect(isCountryCode('GB')).toBe(true);
    expect(isCountryCode('IN')).toBe(true);
    expect(isCountryCode('gb')).toBe(false);
    // "UK" is not the ISO code for the United Kingdom.
    expect(isCountryCode('UK')).toBe(false);
    expect(isCountryCode('ZZ')).toBe(false);
    expect(isCountryCode('')).toBe(false);
  });

  it('accepts literal codes without casts', () => {
    expectTypeOf<'GB'>().toExtend<CountryCode>();
    expectTypeOf<'UK'>().not.toExtend<CountryCode>();
  });
});

describe('entity types', () => {
  it('match the schema list', () => {
    expect(ENTITY_TYPES).toEqual([
      'PERSON',
      'ORG',
      'ADDRESS',
      'EMAIL',
      'PHONE',
      'CARD',
      'BANK',
      'NATIONAL_ID',
      'SECRET',
      'IP',
      'CRYPTO',
      'DOB',
      'DATE',
      'PASSPORT',
      'POSTCODE',
      'CUSTOM',
    ]);
  });

  it('type a detection with a subtype and country', () => {
    const detection: Detection = {
      type: 'NATIONAL_ID',
      subtype: 'UK_NINO',
      country: 'GB',
      start: 0,
      end: 13,
      value: 'QQ 12 34 56 A',
      confidence: 1,
      validated: true,
      source: 'rule',
    };
    expect(detection.subtype).toBe('UK_NINO');
    expectTypeOf<Detection['source']>().toEqualTypeOf<
      'rule' | 'ner' | 'custom' | 'manual'
    >();
  });
});

describe('DEFAULT_SETTINGS', () => {
  it('has the documented defaults', () => {
    expect(DEFAULT_SETTINGS).toMatchObject({
      enabled: true,
      pausedUntil: null,
      mode: 'review',
      homeRegions: [],
      nerThreshold: 0.6,
      keepCity: true,
      retentionDays: 30,
      restoreTooltips: true,
      onboardingDone: false,
      riskMeter: { enabled: true, confirmOnHigh: true },
    });
  });

  it('enables every site and every entity type', () => {
    expect(DEFAULT_SETTINGS.sites).toEqual({
      chatgpt: { enabled: true },
      gemini: { enabled: true },
      claude: { enabled: true },
    });
    expect(Object.keys(DEFAULT_SETTINGS.entityTypes).sort()).toEqual(
      [...ENTITY_TYPES].sort(),
    );
    expect(Object.values(DEFAULT_SETTINGS.entityTypes).every(Boolean)).toBe(
      true,
    );
  });

  it('turns on the pack of every P0 national ID country', () => {
    const packCountries: Record<NationalIdSubtype, CountryCode> = {
      US_SSN: 'US',
      UK_NINO: 'GB',
      UK_NHS: 'GB',
      CA_SIN: 'CA',
      BR_CPF: 'BR',
      IN_AADHAAR: 'IN',
      IN_PAN: 'IN',
      CN_RIC: 'CN',
      SG_NRIC: 'SG',
      ZA_ID: 'ZA',
      ES_DNI: 'ES',
      IT_CF: 'IT',
      FR_NIR: 'FR',
      DE_TAXID: 'DE',
    };
    const packs: Settings['idPacks'] = DEFAULT_SETTINGS.idPacks;
    for (const country of Object.values(packCountries)) {
      expect(packs[country]).toBe(true);
    }
  });

  it('is a valid Settings value', () => {
    expectTypeOf(DEFAULT_SETTINGS).toExtend<Settings>();
  });
});
