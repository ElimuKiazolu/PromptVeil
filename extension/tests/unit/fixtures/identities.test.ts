import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { detectRules } from '@/src/core/detect/rules/detector.ts';
import { COUNTRY_PACKS } from '@/src/core/detect/rules/packs/index.ts';
import { isValidCpf } from '@/src/core/detect/rules/packs/br.ts';
import { isValidSin } from '@/src/core/detect/rules/packs/ca.ts';
import { isValidNino } from '@/src/core/detect/rules/packs/gb.ts';
import { isValidSsn } from '@/src/core/detect/rules/packs/us.ts';
import { isValidRic } from '@/src/core/detect/rules/packs/cn.ts';
import { isValidAadhaar } from '@/src/core/detect/rules/packs/in.ts';
import { isValidNric } from '@/src/core/detect/rules/packs/sg.ts';
import { isValidZaId } from '@/src/core/detect/rules/packs/za.ts';
import { isValidTaxId } from '@/src/core/detect/rules/packs/de.ts';
import { isValidNir } from '@/src/core/detect/rules/packs/fr.ts';
import {
  chineseIdValid,
  cpfValid,
  luhnValid,
  ninoFormatValid,
  nirValid,
  nricValid,
  southAfricanIdValid,
  ssnInAdvertisingRange,
  steuerIdValid,
  verhoeffValid,
} from './id-validators.ts';

interface SourcedValue {
  value: string;
  source: string;
}

interface Identity {
  country: string;
  name: SourcedValue;
  email: SourcedValue;
  phone: SourcedValue;
  nationalId: SourcedValue & { type: string };
  /** A documented example the country's pack detects (for live demos). */
  validExample: SourcedValue & { type: string };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const isSourced = (value: unknown): value is SourcedValue =>
  isRecord(value) &&
  typeof value.value === 'string' &&
  value.value !== '' &&
  typeof value.source === 'string' &&
  value.source !== '';

const isIdentity = (value: unknown): value is Identity =>
  isRecord(value) &&
  typeof value.country === 'string' &&
  isSourced(value.name) &&
  isSourced(value.email) &&
  isSourced(value.phone) &&
  isSourced(value.nationalId) &&
  isRecord(value.nationalId) &&
  typeof value.nationalId.type === 'string' &&
  value.nationalId.type !== '' &&
  isSourced(value.validExample) &&
  isRecord(value.validExample) &&
  typeof value.validExample.type === 'string';

const raw: unknown = JSON.parse(
  readFileSync(
    new URL('../../fixtures/identities.json', import.meta.url),
    'utf8',
  ),
);
if (!Array.isArray(raw) || !raw.every(isIdentity)) {
  throw new Error('identities.json does not match the expected structure');
}
const identities: Identity[] = raw;

const EXPECTED_COUNTRIES = [
  'US',
  'GB',
  'IN',
  'BR',
  'DE',
  'FR',
  'ZA',
  'SG',
  'CN',
  'CA',
];

const idChecks: Record<string, (value: string) => boolean> = {
  US: ssnInAdvertisingRange,
  GB: ninoFormatValid,
  IN: verhoeffValid,
  BR: cpfValid,
  DE: steuerIdValid,
  FR: nirValid,
  ZA: southAfricanIdValid,
  SG: nricValid,
  CN: chineseIdValid,
  CA: luhnValid,
};

describe('identities fixture', () => {
  it('covers each expected country exactly once', () => {
    expect(identities.map((i) => i.country).sort()).toEqual(
      [...EXPECTED_COUNTRIES].sort(),
    );
  });

  it('uses only example.com, example.org or example.net emails', () => {
    for (const { email } of identities) {
      expect(email.value).toMatch(/^[^@\s]+@example\.(com|org|net)$/);
    }
  });

  it('uses phone numbers in international format', () => {
    for (const { phone } of identities) {
      expect(phone.value).toMatch(/^\+\d[\d ()-]{6,}$/);
    }
  });

  it.each(identities.map((i) => [i.country, i] as const))(
    '%s national ID passes its check',
    (country, identity) => {
      const check = idChecks[country];
      expect(check).toBeDefined();
      expect(check?.(identity.nationalId.value)).toBe(true);
    },
  );

  it('rejects corrupted IDs in each validator', () => {
    expect(luhnValid('046 454 287')).toBe(false);
    expect(verhoeffValid('999999990018')).toBe(false);
    expect(cpfValid('111.444.777-36')).toBe(false);
    expect(steuerIdValid('65929970488')).toBe(false);
    expect(nirValid('2 91 01 75 018 002 69')).toBe(false);
    expect(nricValid('S1234567E')).toBe(false);
    expect(chineseIdValid('110105194912310021')).toBe(false);
    expect(southAfricanIdValid('9807055009088')).toBe(false);
  });
});

/** Validators of the country packs that exist so far. */
const packValidators: Record<string, (value: string) => boolean> = {
  US: isValidSsn,
  GB: isValidNino,
  CA: isValidSin,
  BR: isValidCpf,
  IN: isValidAadhaar,
  CN: (value) => isValidRic(value),
  SG: isValidNric,
  ZA: (value) => isValidZaId(value),
  DE: isValidTaxId,
  FR: isValidNir,
};

describe('identities against the country packs', () => {
  it.each(Object.keys(packValidators))(
    '%s valid example passes its pack validator',
    (country) => {
      const identity = identities.find((i) => i.country === country);
      expect(
        packValidators[country]?.(identity?.validExample.value ?? ''),
      ).toBe(true);
    },
  );

  it.each(['US', 'GB', 'CA'])(
    '%s national ID is reserved, labelled so, and rejected by its pack',
    (country) => {
      const identity = identities.find((i) => i.country === country);
      expect(identity?.nationalId.source).toMatch(/^Reserved, not issuable/u);
      expect(packValidators[country]?.(identity?.nationalId.value ?? '')).toBe(
        false,
      );
    },
  );

  it('covers the Review demo: a UK NI number and a Brazilian CPF in one prompt', async () => {
    const gb = identities.find((i) => i.country === 'GB');
    const br = identities.find((i) => i.country === 'BR');
    const text = `My NI number is ${gb?.validExample.value ?? ''} and my CPF is ${br?.nationalId.value ?? ''}.`;
    const detections = await detectRules(text, {
      homeRegions: ['GB'],
      entityTypes: new Set(['NATIONAL_ID']),
      packs: COUNTRY_PACKS,
      exclude: [],
    });
    expect(detections.map((d) => [d.subtype, d.value, d.status])).toEqual([
      ['UK_NINO', gb?.validExample.value, 'confirmed'],
      ['BR_CPF', br?.nationalId.value, 'confirmed'],
    ]);
  });
});
