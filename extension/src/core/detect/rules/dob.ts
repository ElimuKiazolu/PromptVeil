/**
 * Global date-of-birth rule (TR §4.2, P1): a real calendar date from 1900
 * to today, within about 30 characters of a birth word in English, German,
 * French, Spanish, Italian, Portuguese, Chinese, Japanese, Korean or Hindi.
 * Dates without such a word are not reported.
 *
 * Formats are those of src/core/dates/writing.ts. When a numeric date's
 * day and month could be either way round, the first home region's
 * convention decides (US month first; CN, JP, KR year first; day first
 * elsewhere and without a region); the finding then carries that region,
 * so the normal form and the stand-in read the date the same way.
 */
import { calendarDay } from '../../dates/calendar.ts';
import {
  birthDateBounds,
  findDateSpans,
  readDate,
} from '../../dates/writing.ts';
import { INVALID, finding, type Rule } from './types.ts';

export const DOB_CONTEXT_WORDS: readonly string[] = [
  // English, incl. Indian English forms
  'dob',
  'd.o.b',
  'date of birth',
  'birth date',
  'birthdate',
  'birthday',
  'born',
  // German
  'geboren',
  'geb',
  'geburtsdatum',
  'geburtstag',
  // French
  'né',
  'née',
  'date de naissance',
  'naissance',
  // Spanish
  'nacido',
  'nacida',
  'fecha de nacimiento',
  'nacimiento',
  // Italian
  'nato',
  'nata',
  'data di nascita',
  'nascita',
  // Portuguese
  'nascido',
  'nascida',
  'data de nascimento',
  'nascimento',
  // Chinese, Japanese, Korean
  '出生日期',
  '出生于',
  '出生於',
  '生日',
  '生年月日',
  '생년월일',
  // Hindi
  'जन्म तिथि',
  'जन्मतिथि',
];

export const DOB_RULE: Rule = {
  id: 'global.dob',
  type: 'DOB',
  subtype: null,
  country: null,
  find: findDateSpans,
  validate(value, env) {
    const today = calendarDay(Date.now());
    const region = env.homeRegions[0] ?? env.preferredRegions[0] ?? null;
    const reading = readDate(value, region, today, birthDateBounds(today));
    if (reading === null) return INVALID;
    return finding(DOB_RULE, 'structural', {
      country: reading.byRegion ? region : null,
    });
  },
  context: { words: DOB_CONTEXT_WORDS, before: 30, after: 12 },
  contextRequired: true,
  negativeContext: [],
  confidence: { validated: 0.9, context: 0.9, none: 0.9 },
};
