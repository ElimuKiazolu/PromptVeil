import { describe, expect, it } from 'vitest';
import {
  emailDomain,
  emailMatchesPerson,
  nameUnits,
} from '@/src/core/names/email-links.ts';
import {
  emailLocale,
  isWellFormedEmailStandIn,
  RESERVED_DOMAINS,
} from '@/src/core/surrogate/email.ts';
import { generateStandIn } from '@/src/core/surrogate/engine.ts';
import type {
  StandInLinks,
  StandInRequest,
} from '@/src/core/surrogate/types.ts';
import { nameIndex, testEnv } from '../../word-lists.ts';

// Addresses: the fixture identities' (example.org) and made-up ones at
// reserved or made-up domains.
function email(value: string, links?: StandInLinks): StandInRequest {
  return {
    type: 'EMAIL',
    subtype: null,
    country: null,
    value,
    normalised: value.toLowerCase(),
    dateOffsetDays: 40,
    number: 1,
    now: 0,
    ...(links === undefined ? {} : { links }),
  };
}

function seed(n: number): Uint8Array {
  return new Uint8Array(32).map((_, i) => (n * 13 + i * 3) % 256);
}

const env = testEnv({ preferred: ['en_GB'] });

function standIns(real: StandInRequest, count = 30, attempt = 0): string[] {
  const out: string[] = [];
  for (let n = 0; n < count; n += 1) {
    const standIn = generateStandIn(real, seed(n), attempt, env);
    if (standIn !== null) out.push(standIn.value);
  }
  expect(out.length).toBeGreaterThan(count * 0.9);
  return out;
}

const PERSON = { real: 'Harriet Pemberton', standIn: 'Olivia Hughes' };

describe('EMAIL stand-ins', () => {
  it('always use a reserved, undeliverable domain', () => {
    const domains = new Set<string>();
    for (const value of [
      'harriet.pemberton@example.org',
      // A public provider: Gmail issues no address with an underscore, so
      // this one cannot belong to anyone.
      'robin_hale@gmail.com',
      'dana@acme.example',
      'x.y@mail.provider.example',
    ]) {
      for (const standIn of standIns(email(value))) {
        expect(isWellFormedEmailStandIn(standIn)).toBe(true);
        domains.add(emailDomain(standIn));
        expect(standIn).not.toBe(value);
      }
    }
    expect([...domains].sort()).toEqual([...RESERVED_DOMAINS].sort());
    // A public provider is never a stand-in domain. Gmail issues no
    // username shorter than six characters, so this address is nobody's.
    expect(isWellFormedEmailStandIn('olive@gmail.com')).toBe(false);
    expect(isWellFormedEmailStandIn('standin.1.ab12@example.net')).toBe(true);
  });

  it('never keep the real domain, and use the linked one when given', () => {
    for (const standIn of standIns(email('harriet@example.org'))) {
      expect(emailDomain(standIn)).not.toBe('example.org');
    }
    for (const standIn of standIns(
      email('robin.hale@acme.example', { domain: 'example.com' }),
    )) {
      expect(emailDomain(standIn)).toBe('example.com');
    }
  });

  it('draw the domain from what every attempt shares', () => {
    const real = email('robin.hale@acme.example');
    const first = generateStandIn(real, seed(4), 0, env);
    const later = generateStandIn(real, seed(4), 3, env);
    expect(emailDomain(later?.value ?? '')).toBe(
      emailDomain(first?.value ?? ''),
    );
  });

  it("follow the linked person's stand-in in the same pattern", () => {
    const linked = (value: string) =>
      generateStandIn(email(value, { person: PERSON }), seed(2), 0, env)?.value;
    expect(linked('harriet.pemberton@example.org')).toMatch(
      /^olivia\.hughes@example\.(?:com|net)$/u,
    );
    expect(linked('Harriet.Pemberton@acme.example')).toMatch(
      /^Olivia\.Hughes@/u,
    );
    expect(linked('hpemberton84@acme.example')).toMatch(/^ohughes\d{2}@/u);
    expect(linked('pembertonh@acme.example')).toMatch(/^hugheso@/u);
    expect(linked('harriet_p@acme.example')).toMatch(/^olivia_h@/u);
    expect(linked('harrietpemberton@acme.example')).toMatch(/^oliviahughes@/u);
    expect(linked('h.pemberton.1990@acme.example')).toMatch(
      /^o\.hughes\.\d{4}@/u,
    );
  });

  it('vary a linked address on later attempts, so a taken one can be replaced', () => {
    const real = email('harriet.pemberton@example.org', { person: PERSON });
    const first = generateStandIn(real, seed(2), 0, env)?.value;
    const later = generateStandIn(real, seed(2), 1, env)?.value;
    expect(later).toMatch(/^olivia\.hughes\d{2}@/u);
    expect(later).not.toBe(first);
  });

  it('keep role words, the number of digits and the case', () => {
    for (const standIn of standIns(email('info@acme.example'))) {
      expect(standIn).toMatch(/^info@example\.(?:com|org|net)$/u);
    }
    // Later attempts add digits, so two role addresses can still differ.
    for (const standIn of standIns(email('info@acme.example'), 10, 1)) {
      expect(standIn).toMatch(/^info\d{2}@/u);
    }
    for (const standIn of standIns(email('Robin.Hale42@acme.example'))) {
      expect(standIn).toMatch(/^\p{Lu}[a-z]+\.\p{Lu}[a-z]+\d{2}@/u);
      expect(standIn).not.toMatch(/^Robin\.|Hale/u);
    }
    for (const standIn of standIns(email('xq7zz@acme.example'))) {
      expect(standIn).toMatch(/^[a-z]{2}\d[a-z]{2}@/u);
    }
  });

  it('replace given and family names with names of the same kind', () => {
    for (const standIn of standIns(email('harriet.pemberton@example.org'))) {
      const [given, family] = standIn.split('@')[0]?.split('.') ?? [];
      expect(given).toMatch(/^[a-z]{2,}$/u);
      expect(family).toMatch(/^[a-z]{2,}$/u);
      expect(given).not.toBe('harriet');
      expect(family).not.toBe('pemberton');
    }
    expect(
      emailLocale('giulia.rossi@example.org', undefined, nameIndex(), [
        'en_GB',
      ]),
    ).toBe('it');
    expect(
      emailLocale('x@example.org', { ...PERSON }, nameIndex(), ['de']),
    ).toBe(
      // The person's stand-in decides.
      emailLocale('olivia.hughes@x', undefined, nameIndex(), ['de']),
    );
  });
});

describe('email and person links', () => {
  it('find a person in the local part', () => {
    expect(
      emailMatchesPerson('harriet.pemberton@mail.example', 'Harriet Pemberton'),
    ).toBe(true);
    expect(
      emailMatchesPerson('hpemberton@mail.example', 'Dr. Harriet Pemberton'),
    ).toBe(true);
    expect(
      emailMatchesPerson('pembertonh@mail.example', 'Harriet Pemberton'),
    ).toBe(true);
    expect(
      emailMatchesPerson('HARRIET@mail.example', 'Harriet Pemberton'),
    ).toBe(true);
    expect(emailMatchesPerson('josé.garcía@mail.example', 'José García')).toBe(
      true,
    );
    expect(emailMatchesPerson('jose.garcia@mail.example', 'José García')).toBe(
      true,
    );
    expect(emailMatchesPerson('info@mail.example', 'Harriet Pemberton')).toBe(
      false,
    );
    // Initials alone do not make a match.
    expect(emailMatchesPerson('hp@mail.example', 'Harriet Pemberton')).toBe(
      false,
    );
    expect(emailMatchesPerson('robin@mail.example', 'Harriet Pemberton')).toBe(
      false,
    );
  });

  it('split a token into whole parts and initials, each part once', () => {
    const parts = ['Harriet', 'Pemberton'];
    expect(nameUnits('hpemberton', parts)).toEqual([
      { part: 0, initial: true },
      { part: 1, initial: false },
    ]);
    expect(nameUnits('harrietharriet', parts)).toBeNull();
    expect(nameUnits('hp', parts)).toBeNull();
  });
});
