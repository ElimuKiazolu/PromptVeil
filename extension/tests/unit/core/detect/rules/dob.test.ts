import { sha256 } from '@noble/hashes/sha2.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import { describe, expect, it } from 'vitest';
import {
  ageOn,
  calendarDay,
  isoDate,
  toTime,
  type CalendarDate,
} from '@/src/core/dates/calendar.ts';
import { readDate } from '@/src/core/dates/writing.ts';
import { normaliseReal } from '@/src/core/detect/normal-form.ts';
import { detectRules } from '@/src/core/detect/rules/detector.ts';
import { COUNTRY_PACKS } from '@/src/core/detect/rules/packs/index.ts';
import { netForms } from '@/src/core/net/forms.ts';
import { birthDateStandIn } from '@/src/core/surrogate/dob.ts';
import {
  generateStandIn,
  isWellFormedStandIn,
} from '@/src/core/surrogate/engine.ts';
import type { StandInRequest } from '@/src/core/surrogate/types.ts';
import type { CountryCode } from '@/src/shared/country.ts';
import {
  ENTITY_TYPES,
  type Detection,
  type EntityType,
} from '@/src/shared/entities.ts';

// Fictional dates of birth; seeds and masking days are made up.

async function detect(
  text: string,
  homeRegions: readonly CountryCode[] = ['GB'],
  types: readonly EntityType[] = ENTITY_TYPES,
): Promise<Detection[]> {
  return detectRules(text, {
    homeRegions,
    entityTypes: new Set<EntityType>(types),
    packs: COUNTRY_PACKS,
    exclude: [],
  });
}

const dobs = async (
  text: string,
  homeRegions: readonly CountryCode[] = ['GB'],
): Promise<string[]> =>
  (await detect(text, homeRegions))
    .filter((d) => d.type === 'DOB')
    .map((d) => `${d.status}:${d.value}`);

describe('DOB detection', () => {
  it.each([
    ['DOB: 12/03/1990', '12/03/1990'],
    ['D.O.B. 12.03.1990', '12.03.1990'],
    ['D.O.B 12-03-1990', '12-03-1990'],
    ['date of birth 1990-03-12', '1990-03-12'],
    ['dateOfBirth: "1990-03-12"', '1990-03-12'],
    ['birth_date=1990-03-12', '1990-03-12'],
    ['She was born on 12 March 1990.', '12 March 1990'],
    ['Born March 12, 1990 in a small town', 'March 12, 1990'],
    ['Birthday: 12th of March 1990', '12th of March 1990'],
    ['Geburtsdatum: 12.03.1990', '12.03.1990'],
    ['geb. am 12. März 1990', '12. März 1990'],
    ['Er wurde am 12. März 1990 geboren', '12. März 1990'],
    ['née le 1er mars 1990', '1er mars 1990'],
    ['Date de naissance : 12/03/1990', '12/03/1990'],
    ['nacida el 12 de marzo de 1990', '12 de marzo de 1990'],
    ['Fecha de nacimiento: 12/03/1990', '12/03/1990'],
    ['nato il 12 maggio 1990', '12 maggio 1990'],
    ['data di nascita 12/03/1990', '12/03/1990'],
    ['nascido em 12 de março de 1990', '12 de março de 1990'],
    ['Data de nascimento: 12/03/1990', '12/03/1990'],
    ['出生日期：1990年3月12日', '1990年3月12日'],
    ['生日 1990-03-12', '1990-03-12'],
    ['생년월일 1990년 3월 12일', '1990년 3월 12일'],
    ['जन्म तिथि: 12/03/1990', '12/03/1990'],
  ])('finds %s', async (text, value) => {
    expect(await dobs(text)).toEqual([`confirmed:${value}`]);
  });

  it('needs a birth word nearby', async () => {
    for (const text of [
      'Invoice date 12/03/2024, due 12/04/2024.',
      'The meeting is on 12 March 2025.',
      'Release 2024.03.12 shipped; build 12-03-2024.',
      'Version 1.2.10 and v12.03.90',
      'Le document est nécessaire avant le 12/03/2024.',
      'Order placed 1990-03-12 by the customer.',
    ]) {
      expect(await dobs(text), text).toEqual([]);
    }
  });

  it('rejects dates that do not exist or are in the future', async () => {
    expect(await dobs('DOB 31/04/1990')).toEqual([]);
    expect(await dobs('DOB 29/02/1990')).toEqual([]);
    expect(await dobs('DOB 29/02/1992')).toEqual(['confirmed:29/02/1992']);
    expect(await dobs('DOB 12/03/2099')).toEqual([]);
    expect(await dobs('DOB 12/03/1899')).toEqual([]);
  });

  it('reads a 2-digit year as not in the future', async () => {
    const [found] = await detect('DOB 12/03/90');
    expect(found?.type).toBe('DOB');
    expect(
      normaliseReal('DOB', null, found?.country ?? null, found?.value ?? ''),
    ).toBe('1990-03-12');
  });

  it('records the home region when it decided the order', async () => {
    const [gb] = await detect('DOB 03/04/1990', ['GB']);
    const [us] = await detect('DOB 03/04/1990', ['US']);
    const [clear] = await detect('DOB 03/25/1990', ['GB']);
    expect(gb?.country).toBe('GB');
    expect(us?.country).toBe('US');
    expect(clear?.country).toBeNull();
    expect(normaliseReal('DOB', null, 'GB', '03/04/1990')).toBe('1990-04-03');
    expect(normaliseReal('DOB', null, 'US', '03/04/1990')).toBe('1990-03-04');
    expect(normaliseReal('DOB', null, null, '03/25/1990')).toBe('1990-03-25');
    expect(normaliseReal('DOB', null, null, '12 März 1990')).toBe('1990-03-12');
  });

  it('wins over a phone reading of the same digits', async () => {
    const found = await detect('DOB 12.03.1990', ['DE']);
    expect(found.map((d) => d.type)).toEqual(['DOB']);
  });
});

const NOW = toTime({ year: 2026, month: 11, day: 20 });
const seed = (label: string) => sha256(utf8ToBytes(label));

function request(
  value: string,
  options: { country?: CountryCode | null; offset?: number; now?: number } = {},
): StandInRequest {
  const country = options.country ?? null;
  return {
    type: 'DOB',
    subtype: null,
    country,
    value,
    normalised: normaliseReal('DOB', null, country, value),
    dateOffsetDays: options.offset ?? 45,
    number: 1,
    now: options.now ?? NOW,
  };
}

describe('DOB stand-ins', () => {
  it('are written exactly like the real date', () => {
    const cases: readonly [string, RegExp][] = [
      ['12/03/1990', /^\d{2}\/\d{2}\/\d{4}$/u],
      ['2/3/1990', /^\d{1,2}\/\d{1,2}\/\d{4}$/u],
      ['1990-03-12', /^\d{4}-\d{2}-\d{2}$/u],
      ['12.03.90', /^\d{2}\.\d{2}\.\d{2}$/u],
      ['12 March 1990', /^\d{1,2} [A-Z][a-z]+ \d{4}$/u],
      ['12 MARCH 1990', /^\d{1,2} [A-Z]+ \d{4}$/u],
      ['March 12, 1990', /^[A-Z][a-z]+ \d{1,2}, \d{4}$/u],
      ['12. März 1990', /^\d{1,2}\. [A-ZÄ][a-zä]+ \d{4}$/u],
      ['12 de marzo de 1990', /^\d{1,2} de [a-z]+ de \d{4}$/u],
      ['1990年3月12日', /^\d{4}年\d{1,2}月\d{1,2}日$/u],
    ];
    for (const [real, shape] of cases) {
      const standIn = generateStandIn(request(real), seed(real), 0);
      expect(standIn?.value, real).toMatch(shape);
      expect(standIn?.value).not.toBe(real);
      expect(isWellFormedStandIn(request(real), standIn?.value ?? '')).toBe(
        true,
      );
    }
  });

  it('keep the language of the month name', () => {
    const standIn = generateStandIn(
      request('12. März 1990', { offset: 60 }),
      seed('de'),
      0,
    );
    expect(standIn?.value).toBe('11. Mai 1990');
    expect(standIn?.normalised).toBe('1990-05-11');
    expect(standIn?.parts).toEqual(['DMY']);
  });

  it('keep the order of an ambiguous date', () => {
    const us = generateStandIn(
      request('03/04/1990', { country: 'US', offset: 60 }),
      seed('us'),
      0,
    );
    // 4 March 1990 + 60 days = 3 May 1990, written month first.
    expect(us?.value).toBe('05/03/1990');
    expect(us?.parts).toEqual(['MDY']);
    const gb = generateStandIn(
      request('03/04/1990', { country: 'GB', offset: 60 }),
      seed('gb'),
      0,
    );
    // 3 April 1990 + 60 days = 2 June 1990, written day first.
    expect(gb?.value).toBe('02/06/1990');
    expect(gb?.parts).toEqual(['DMY']);
  });

  it('preserve the age on the day of masking, for many offsets and days', () => {
    let checked = 0;
    for (let n = 0; n < 400; n += 1) {
      const bytes = seed(`age ${n.toString()}`);
      const at = (i: number): number => bytes[i] ?? 0;
      const real: CalendarDate = {
        year: 1930 + (at(0) % 95),
        month: 1 + (at(1) % 12),
        day: 1 + (at(2) % 28),
      };
      const magnitude = 30 + (((at(3) << 8) | at(4)) % 336);
      const offset = at(5) % 2 === 0 ? magnitude : -magnitude;
      const today = calendarDay(NOW - (at(6) % 200) * 86_400_000);
      if (isoDate(real) > isoDate(today)) continue;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const standIn = birthDateStandIn(real, offset, attempt, today);
        if (standIn === null) continue;
        checked += 1;
        expect(ageOn(standIn, today)).toBe(ageOn(real, today));
        expect(isoDate(standIn)).not.toBe(isoDate(real));
        expect(isoDate(standIn) <= isoDate(today)).toBe(true);
        expect(isoDate(standIn) >= '1900-01-01').toBe(true);
      }
    }
    expect(checked).toBeGreaterThan(1100);
  });

  it('handle 29 February and an offset of a whole year', () => {
    const today: CalendarDate = { year: 2026, month: 11, day: 20 };
    const leap: CalendarDate = { year: 1992, month: 2, day: 29 };
    for (const offset of [-365, -300, 30, 45, 300, 365]) {
      const standIn = birthDateStandIn(leap, offset, 0, today);
      expect(standIn, offset.toString()).not.toBeNull();
      if (standIn === null) continue;
      expect(ageOn(standIn, today)).toBe(ageOn(leap, today));
      expect(isoDate(standIn)).not.toBe('1992-02-29');
    }
    // A whole year either way is undone by the age correction, so that
    // attempt has none and the next one moves a day further.
    const real: CalendarDate = { year: 1990, month: 3, day: 12 };
    expect(birthDateStandIn(real, 365, 0, today)).toBeNull();
    const standIn = birthDateStandIn(real, 365, 1, today);
    expect(standIn).not.toBeNull();
    expect(isoDate(standIn ?? real)).not.toBe('1990-03-12');
    expect(ageOn(standIn ?? real, today)).toBe(36);
  });

  it('stay between 1900 and today', () => {
    const today: CalendarDate = { year: 2026, month: 11, day: 20 };
    const newborn = birthDateStandIn(
      { year: 2026, month: 11, day: 1 },
      200,
      0,
      today,
    );
    expect(newborn).not.toBeNull();
    expect(isoDate(newborn ?? today) <= '2026-11-20').toBe(true);
    const early = birthDateStandIn(
      { year: 1900, month: 1, day: 10 },
      -200,
      0,
      today,
    );
    expect(isoDate(early ?? today) >= '1900-01-01').toBe(true);
  });

  it('move further with each attempt', () => {
    const r = request('12/03/1990');
    const values = new Set(
      [0, 1, 2, 3].map(
        (attempt) => generateStandIn(r, seed('a'), attempt)?.value,
      ),
    );
    expect(values.size).toBe(4);
  });
});

describe('DOB request-net forms', () => {
  it('cover the digit orders and English written forms', () => {
    const forms = netForms('DOB', '12. März 1990', '1990-03-12');
    for (const form of [
      '12märz1990',
      '19900312',
      '12031990',
      '03121990',
      '12march1990',
      'march121990',
      '12mar1990',
      'mar121990',
      '12thmarch1990',
      'march12th1990',
    ]) {
      expect(forms, form).toContain(form);
    }
    expect(netForms('DOB', '1/3/1990', '1990-03-01')).toContain('1stmar1990');
    // Readings agree: the reply and the request use the same date.
    expect(readDate('12/03/1990', null, calendarDay(NOW))?.date).toEqual({
      year: 1990,
      month: 3,
      day: 12,
    });
  });
});
