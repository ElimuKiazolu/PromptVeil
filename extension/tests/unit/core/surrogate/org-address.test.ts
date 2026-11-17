import { describe, expect, it } from 'vitest';
import type { CountryCode } from '@/src/shared/country.ts';
import {
  generateStandIn,
  WORD_TYPES,
  wordListFor,
} from '@/src/core/surrogate/engine.ts';
import { addressLocale } from '@/src/core/surrogate/address.ts';
import { orgLocale } from '@/src/core/surrogate/org.ts';
import type {
  StandInEnvironment,
  StandInRequest,
} from '@/src/core/surrogate/types.ts';
import { localeWords, nameIndex, testEnv } from '../../word-lists.ts';

// Organisation names and addresses here are made up or textbook examples
// (e.g. 221B Baker Street, a fictional address).
function request(
  type: 'ORG' | 'ADDRESS',
  value: string,
  country: CountryCode | null = null,
): StandInRequest {
  return {
    type,
    subtype: null,
    country,
    value,
    normalised: value.toLowerCase(),
    dateOffsetDays: 40,
    number: 1,
    now: 0,
  };
}

function seed(n: number): Uint8Array {
  return new Uint8Array(32).map((_, i) => (n * 17 + i * 5) % 256);
}

const env = testEnv({ preferred: ['en_GB'] });

function standIns(
  real: StandInRequest,
  count = 20,
  environment: StandInEnvironment = env,
): string[] {
  const out: string[] = [];
  for (let n = 0; n < count; n += 1) {
    const standIn = generateStandIn(real, seed(n), 0, environment);
    if (standIn !== null) out.push(standIn.value);
  }
  expect(out.length).toBeGreaterThan(count * 0.9);
  return out;
}

describe('ORG stand-ins', () => {
  it('keep the legal suffix where it was', () => {
    for (const [value, suffix] of [
      ['Pemberton & Clarke Ltd', ' Ltd'],
      ['Hale Systems Inc.', ' Inc.'],
      ['Whitfield Ventures LLC', ' LLC'],
      ['Schmidt Logistik GmbH', ' GmbH'],
      ['Mehta Textiles Pvt Ltd', ' Pvt Ltd'],
      ['Okafor Holdings Pty Ltd', ' Pty Ltd'],
      ['Construcciones García S.A.', ' S.A.'],
      ['Rossi Costruzioni S.p.A.', ' S.p.A.'],
      ['Martin Conseil SARL', ' SARL'],
      ['Silva Comércio Ltda', ' Ltda'],
      ['De Vries Bouw B.V.', ' B.V.'],
    ] as const) {
      for (const standIn of standIns(request('ORG', value))) {
        expect(standIn.endsWith(suffix)).toBe(true);
        expect(standIn).not.toBe(value);
      }
    }
    for (const standIn of standIns(request('ORG', 'ООО Ромашка'))) {
      expect(standIn.startsWith('ООО ')).toBe(true);
    }
    for (const standIn of standIns(request('ORG', '北京华为技术有限公司'))) {
      expect(standIn.endsWith('有限公司')).toBe(true);
      expect(standIn).toMatch(/^\p{Script=Han}+$/u);
    }
  });

  it('keep what kind of organisation it is, and put a place after "of"', () => {
    const places = new Set(localeWords('en_GB').localities);
    for (const standIn of standIns(request('ORG', 'University of Leeds'))) {
      expect(standIn).toMatch(/^University of /u);
      expect(places.has(standIn.slice('University of '.length))).toBe(true);
    }
    for (const standIn of standIns(
      request('ORG', 'Pemberton General Hospital'),
    )) {
      expect(standIn).toMatch(/^\S+ General Hospital$/u);
    }
    for (const standIn of standIns(request('ORG', 'Banco Santander'))) {
      expect(standIn).toMatch(/^Banco \S+$/u);
    }
    // Only kind words: a name is put first.
    for (const standIn of standIns(request('ORG', 'University Hospital'))) {
      expect(standIn).toMatch(/^\S+ University Hospital$/u);
    }
  });

  it('replace acronyms with capitals of the same length and digits with digits', () => {
    for (const standIn of standIns(request('ORG', 'ACME Pvt Ltd'))) {
      expect(standIn).toMatch(/^[A-Z]{4} Pvt Ltd$/u);
      expect(standIn).not.toBe('ACME Pvt Ltd');
    }
    for (const standIn of standIns(request('ORG', 'Studio 54 Ltd'))) {
      expect(standIn).toMatch(/^\S+ \d\d Ltd$/u);
    }
  });

  it('take names from the locale the suffix or kind word shows', () => {
    const index = nameIndex();
    expect(orgLocale('Schmidt Logistik GmbH', index, ['en_GB'])).toBe('de');
    expect(orgLocale('Mehta Textiles Pvt Ltd', index, ['en_GB'])).toBe('en_IN');
    expect(orgLocale('Università di Bologna', index, ['en_GB'])).toBe('it');
    // Nothing known: the home locale.
    expect(orgLocale('Xqzv & Wrrtpl Ltd', index, ['en_GB'])).toBe('en_GB');
    const german = new Set(localeWords('de').family.any);
    for (const standIn of standIns(request('ORG', 'Schmidt Becker GmbH'))) {
      const [a, b] = standIn.split(' ');
      expect(german.has(a ?? '')).toBe(true);
      expect(german.has(b ?? '')).toBe(true);
    }
  });
});

describe('word lists a request needs', () => {
  it('name one locale per type that uses them, none for the others', () => {
    const at = (
      type: StandInRequest['type'],
      value: string,
      country: CountryCode | null = null,
    ) => wordListFor({ type, value, country }, env);
    expect(at('PERSON', 'Giulia Rossi')).toBe('it');
    expect(at('ORG', 'Schmidt Logistik GmbH')).toBe('de');
    expect(at('ADDRESS', 'Hauptstraße 5, 10115 Berlin', 'DE')).toBe('de');
    expect(at('EMAIL', 'info@acme.example')).toBe('en_GB');
    expect(at('CARD', '4111 1111 1111 1111')).toBeNull();
    expect(WORD_TYPES.has('PHONE')).toBe(false);
  });
});

describe('ADDRESS stand-ins', () => {
  const cases: [CountryCode, string, RegExp, string[]][] = [
    [
      'GB',
      '221B Baker Street, Marylebone, London NW1 6XE, United Kingdom',
      /^\d{3}B \S+ Street, [^,]+, London [A-Z]{1,2}\d[A-Z\d]? \d[A-Z]{2}, United Kingdom$/u,
      ['Baker', 'Marylebone', 'NW1 6XE', '221'],
    ],
    [
      'GB',
      '221B Baker Street London NW1 6XE',
      /^\d{3}B \S+ Street London [A-Z]{1,2}\d[A-Z\d]? \d[A-Z]{2}$/u,
      ['Baker', 'NW1 6XE'],
    ],
    [
      'US',
      '1850 Larkspur Avenue NW, Washington, DC 20009, USA',
      /^\d{4} \S+ Avenue NW, Washington, DC \d{5}, USA$/u,
      ['Larkspur', '20009', '1850'],
    ],
    [
      'CA',
      '24 Birchmount Drive, Ottawa, ON K2P 1L4, Canada',
      /^\d{2} \S+ Drive, Ottawa, ON [A-Z]\d[A-Z] \d[A-Z]\d, Canada$/u,
      ['Birchmount', 'K2P 1L4'],
    ],
    [
      'DE',
      'Hauptstraße 5, 10115 Berlin',
      /^\S+straße \d, \d{5} Berlin$/u,
      ['Hauptstraße', '10115'],
    ],
    [
      'FR',
      '12 rue de la Paix, 75002 Paris, France',
      /^\d{2} rue de la \S+, \d{5} Paris, France$/u,
      ['Paix', '75002'],
    ],
    [
      'IT',
      'Via Roma 10, 00184 Roma',
      /^Via \S+ \d{2}, \d{5} Roma$/u,
      ['Via Roma 10', '00184'],
    ],
    [
      'ES',
      'Calle Mayor 7, 28013 Madrid, España',
      /^Calle \S+ \d, \d{5} Madrid, España$/u,
      ['Mayor', '28013'],
    ],
    [
      'BR',
      'Rua Augusta 1500, São Paulo - SP, 01304-001',
      /^Rua \S+ \d{4}, São Paulo - SP, \d{5}-\d{3}$/u,
      ['Augusta', '01304-001'],
    ],
    [
      'NL',
      'Kerkstraat 12, 1017 GC Amsterdam',
      /^\S+straat \d{2}, \d{4} [A-Z]{2} Amsterdam$/u,
      ['Kerkstraat', '1017 GC'],
    ],
    [
      'PL',
      'ul. Długa 5, 00-238 Warszawa',
      /^ul\. \S+ \d, \d{2}-\d{3} Warszawa$/u,
      ['Długa', '00-238'],
    ],
    [
      'SE',
      'Storgatan 3, 111 51 Stockholm',
      /^\S+gatan \d, \d{3} \d{2} Stockholm$/u,
      ['Storgatan', '111 51'],
    ],
    [
      'AU',
      '10 Smith Street, Sydney NSW 2000',
      /^\d{2} \S+ Street, Sydney NSW \d{4}$/u,
      ['Smith', ' 2000'],
    ],
    [
      'IN',
      '14 MG Road, Bengaluru 560001',
      /^\d{2} \S+ Road, Bengaluru \d{6}$/u,
      ['560001'],
    ],
  ];

  it('replace number, street, localities and postcode in the country format; keep city and country', () => {
    for (const [country, value, shape, gone] of cases) {
      for (const standIn of standIns(request('ADDRESS', value, country), 15)) {
        expect(standIn).toMatch(shape);
        for (const part of gone) expect(standIn).not.toContain(part);
      }
    }
  });

  it('replace the city too when keepCity is off', () => {
    const noCity = testEnv({ preferred: ['en_GB'], keepCity: false });
    for (const standIn of standIns(
      request('ADDRESS', 'Flat 3, 12 Acacia Avenue, Leeds LS1 4AB', 'GB'),
      15,
      noCity,
    )) {
      expect(standIn).toMatch(
        /^Flat \d, \d{2} \S+ Avenue, .+ [A-Z]{1,2}\d[A-Z\d]? \d[A-Z]{2}$/u,
      );
      expect(standIn).not.toContain('Leeds');
    }
    for (const standIn of standIns(
      request('ADDRESS', 'Hauptstraße 5, 10115 Berlin', 'DE'),
      15,
      noCity,
    )) {
      expect(standIn).not.toContain('Berlin');
    }
  });

  it('rename roads and replace numbers in CJK addresses', () => {
    for (const standIn of standIns(
      request('ADDRESS', '北京市朝阳区建国路88号', 'CN'),
      15,
    )) {
      expect(standIn).toMatch(/^北京市朝阳区\p{Script=Han}{2}路\d{2}号$/u);
      expect(standIn).not.toContain('建国');
    }
  });

  it('find the country from its name, the postcode or the home region', () => {
    expect(addressLocale('Calle Mayor 7, 28013 Madrid, España', null, [])).toBe(
      'es',
    );
    expect(addressLocale('10 Acacia Avenue, London EC1A 1BB', null, [])).toBe(
      'en_GB',
    );
    // Five digits fit many countries: the home region's format decides.
    expect(addressLocale('Hauptstraße 5, 10115 Berlin', null, ['de'])).toBe(
      'de',
    );
    expect(addressLocale('Hauptstraße 5, 10115 Berlin', 'DE', ['en_GB'])).toBe(
      'de',
    );
  });
});
