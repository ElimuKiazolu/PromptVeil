import { describe, expect, it } from 'vitest';
import {
  ageOn,
  isRealDate,
  isoDate,
  parseIsoDate,
  withYear,
  type CalendarDate,
} from '@/src/core/dates/calendar.ts';
import {
  birthDateBounds,
  findDateSpans,
  parseDateWriting,
  readAs,
  readDate,
  writeAs,
  type DateOrder,
} from '@/src/core/dates/writing.ts';

// Fictional dates throughout.
const today: CalendarDate = { year: 2026, month: 11, day: 20 };
const date = (year: number, month: number, day: number): CalendarDate => ({
  year,
  month,
  day,
});

describe('calendar', () => {
  it('knows month ends and leap years', () => {
    expect(isRealDate(2024, 2, 29)).toBe(true);
    expect(isRealDate(2023, 2, 29)).toBe(false);
    expect(isRealDate(1900, 2, 29)).toBe(false);
    expect(isRealDate(2000, 2, 29)).toBe(true);
    expect(isRealDate(1990, 4, 31)).toBe(false);
    expect(isRealDate(1990, 12, 31)).toBe(true);
    expect(isRealDate(1990, 13, 1)).toBe(false);
    expect(isRealDate(1990, 1, 0)).toBe(false);
  });

  it('counts ages, with 29 February birthdays on 1 March', () => {
    expect(ageOn(date(1990, 3, 12), date(2026, 3, 11))).toBe(35);
    expect(ageOn(date(1990, 3, 12), date(2026, 3, 12))).toBe(36);
    expect(ageOn(date(2000, 2, 29), date(2026, 2, 28))).toBe(25);
    expect(ageOn(date(2000, 2, 29), date(2026, 3, 1))).toBe(26);
    expect(ageOn(date(2000, 2, 29), date(2028, 2, 29))).toBe(28);
  });

  it('moves 29 February to 28 February in a year without it', () => {
    expect(withYear(date(2000, 2, 29), 2001)).toEqual(date(2001, 2, 28));
    expect(withYear(date(2000, 2, 29), 2004)).toEqual(date(2004, 2, 29));
  });

  it('writes and reads ISO dates', () => {
    expect(isoDate(date(1990, 3, 2))).toBe('1990-03-02');
    expect(parseIsoDate('1990-03-02')).toEqual(date(1990, 3, 2));
    expect(parseIsoDate('1990-02-30')).toBeNull();
  });
});

describe('reading written dates', () => {
  const cases: readonly [string, CalendarDate][] = [
    ['12/03/1990', date(1990, 3, 12)],
    ['12.03.1990', date(1990, 3, 12)],
    ['12-03-1990', date(1990, 3, 12)],
    ['1990-03-12', date(1990, 3, 12)],
    ['1990/3/12', date(1990, 3, 12)],
    ['25/12/90', date(1990, 12, 25)],
    ['12 March 1990', date(1990, 3, 12)],
    ['12th March 1990', date(1990, 3, 12)],
    ['12th of March 1990', date(1990, 3, 12)],
    ['March 12, 1990', date(1990, 3, 12)],
    ['Mar. 12th, 1990', date(1990, 3, 12)],
    ['12-Mar-1990', date(1990, 3, 12)],
    ['12. März 1990', date(1990, 3, 12)],
    ['12. Maerz 1990', date(1990, 3, 12)],
    ['1er mars 1990', date(1990, 3, 1)],
    ['12 février 1990', date(1990, 2, 12)],
    ['12 fevrier 1990', date(1990, 2, 12)],
    ['12 de marzo de 1990', date(1990, 3, 12)],
    ['12 marzo 1990', date(1990, 3, 12)],
    ['12 de março de 1990', date(1990, 3, 12)],
    ['1º de março de 1990', date(1990, 3, 1)],
    ['1990年3月12日', date(1990, 3, 12)],
    ['1990년 3월 12일', date(1990, 3, 12)],
    ['１９９０年３月１２日', date(1990, 3, 12)],
  ];

  it.each(cases)('reads %s', (text, expected) => {
    expect(readDate(text, null, today)?.date).toEqual(expected);
  });

  it('lets a part above 12 decide the order, else the region', () => {
    expect(readDate('03/25/1990', 'GB', today)).toMatchObject({
      order: 'MDY',
      ambiguous: false,
      byRegion: false,
    });
    expect(readDate('03/04/1990', 'GB', today)).toMatchObject({
      order: 'DMY',
      date: date(1990, 4, 3),
      ambiguous: true,
      byRegion: true,
    });
    expect(readDate('03/04/1990', 'US', today)).toMatchObject({
      order: 'MDY',
      date: date(1990, 3, 4),
      ambiguous: true,
    });
    expect(readDate('03/04/1990', null, today)?.order).toBe('DMY');
    // Year first for CN/JP/KR when a 2-digit year could come first.
    expect(readDate('03/04/05', 'CN', today)?.date).toEqual(date(2003, 4, 5));
    // The same date either way: not ambiguous, the region still writes it.
    expect(readDate('05/05/1990', 'US', today)).toMatchObject({
      order: 'MDY',
      ambiguous: false,
      byRegion: true,
    });
  });

  it('drops readings outside the bounds before choosing', () => {
    // 11 December 2026 is in the future; only 12 November remains.
    expect(
      readDate('11/12/2026', 'GB', today, birthDateBounds(today)),
    ).toMatchObject({ order: 'MDY', ambiguous: false });
    expect(readDate('12/03/2099', null, today, birthDateBounds(today))).toBe(
      null,
    );
    expect(readDate('12/03/1899', null, today, birthDateBounds(today))).toBe(
      null,
    );
  });

  it('reads two-digit years as not in the future', () => {
    expect(readDate('12/03/90', null, today)?.date.year).toBe(1990);
    expect(readDate('12/03/25', null, today)?.date.year).toBe(2025);
    expect(readDate('12/03/27', null, today)?.date.year).toBe(1927);
  });

  it('rejects dates that do not exist and other shapes', () => {
    for (const text of [
      '31/04/1990',
      '29/02/1990',
      '1990-13-01',
      '12/03',
      '1.2.3',
      '12/03/199',
      '12 Foo 1990',
      'March 1990',
      '12 March 1990 April',
    ]) {
      expect(readDate(text, null, today), text).toBeNull();
    }
    expect(readDate('29/02/1992', null, today)?.date).toEqual(
      date(1992, 2, 29),
    );
  });
});

describe('writing a date like another', () => {
  const samples: readonly string[] = [
    '12/03/1990',
    '2/3/1990',
    '02.03.1990',
    '1990-03-12',
    '12/03/90',
    '12 March 1990',
    '12 MARCH 1990',
    '12 mar 1990',
    '12th of March 1990',
    'March 12, 1990',
    'Mar. 12th, 1990',
    '12-Mar-1990',
    '12. März 1990',
    '1er mars 1990',
    '12 février 1990',
    '12 de marzo de 1990',
    '12 giugno 1990',
    '1º de março de 1990',
    '1990年3月12日',
    '１９９０年３月１２日',
  ];

  it.each(samples)('writes %s back unchanged', (text) => {
    const reading = readDate(text, null, today);
    if (reading === null) throw new Error(text);
    expect(writeAs(reading.writing, reading.order, reading.date)).toBe(text);
  });

  it('keeps padding, language, case and ordinals', () => {
    const write = (text: string, order: DateOrder, to: CalendarDate) => {
      const writing = parseDateWriting(text);
      if (writing === null) throw new Error(text);
      return writeAs(writing, order, to);
    };
    const may = date(1991, 5, 1);
    const june = date(1989, 6, 22);
    expect(write('12/03/1990', 'DMY', may)).toBe('01/05/1991');
    expect(write('2/3/1990', 'DMY', june)).toBe('22/6/1989');
    expect(write('03/12/1990', 'MDY', may)).toBe('05/01/1991');
    expect(write('12/03/90', 'DMY', may)).toBe('01/05/91');
    expect(write('12 MARCH 1990', 'DMY', may)).toBe('1 MAY 1991');
    expect(write('12th March 1990', 'DMY', june)).toBe('22nd June 1989');
    expect(write('12TH March 1990', 'DMY', may)).toBe('1ST May 1991');
    expect(write('12. März 1990', 'DMY', may)).toBe('1. Mai 1991');
    expect(write('12. Mrz. 1990', 'DMY', june)).toBe('22. Jun. 1989');
    expect(write('1er mars 1990', 'DMY', june)).toBe('22 juin 1989');
    expect(write('12 mars 1990', 'DMY', may)).toBe('1 mai 1991');
    expect(write('12 fevrier 1990', 'DMY', date(1990, 8, 3))).toBe(
      '3 aout 1990',
    );
    expect(write('12 de marzo de 1990', 'DMY', may)).toBe('1 de mayo de 1991');
    expect(write('12 de março de 1990', 'DMY', may)).toBe('1 de maio de 1991');
    expect(write('12 maggio 1990', 'DMY', june)).toBe('22 giugno 1989');
    // Spelled alike in Spanish and Italian, with no other hint: Spanish.
    expect(write('12 marzo 1990', 'DMY', june)).toBe('22 junio 1989');
    expect(write('12 de marzo de 1990', 'DMY', june)).toBe(
      '22 de junio de 1989',
    );
    expect(write('1990年3月12日', 'YMD', june)).toBe('1989年6月22日');
  });

  it('reads a writing in an order it does not allow as nothing', () => {
    const writing = parseDateWriting('12 March 1990');
    if (writing === null) throw new Error('parse');
    expect(readAs(writing, 'MDY', today)).toBeNull();
    expect(writeAs(writing, 'YMD', date(1990, 1, 1))).toBeNull();
  });
});

describe('finding dates in text', () => {
  const found = (text: string): string[] =>
    findDateSpans(text).map((span) => text.slice(span.start, span.end));

  it('finds every format', () => {
    expect(
      found(
        'DOB 12/03/1990, born 12 March 1990 (March 12, 1990), geb. 12. März 1990; 出生日期1990年3月12日 or 1990-03-12.',
      ),
    ).toEqual([
      '12/03/1990',
      '12 March 1990',
      'March 12, 1990',
      '12. März 1990',
      '1990年3月12日',
      '1990-03-12',
    ]);
    expect(
      found('né le 1er mars 1990 / nacida el 12 de marzo de 1990'),
    ).toEqual(['1er mars 1990', '12 de marzo de 1990']);
  });

  it('skips versions, addresses and glued numbers', () => {
    expect(found('v1.2.10 and 10.12.20.3 and 1.2.3.4 and x12/03/1990')).toEqual(
      [],
    );
    expect(found('2012/03/12/4 build 12-03-1990-7')).toEqual([]);
    expect(found('12 Marchand 1990')).toEqual([]);
  });

  it('runs in linear time on long inputs', () => {
    const text = `${'12/03/'.repeat(5000)} ${'12 March '.repeat(5000)}`;
    const started = performance.now();
    findDateSpans(text);
    expect(performance.now() - started).toBeLessThan(500);
  });
});
