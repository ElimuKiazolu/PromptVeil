/**
 * The locales of the bundled word lists (public/data/<id>.json, built by
 * scripts/build-wordlists.ts from Faker's locale definitions), with the
 * script their names are written in and the regions they stand for.
 *
 * Pure data, shared by the build script and the stand-in engine.
 */
import type { CountryCode } from '../../../shared/country.ts';
import type { Script } from '../../names/script.ts';

export { scriptOf, type Script } from '../../names/script.ts';

export interface LocaleInfo {
  readonly id: string;
  readonly script: Script;
  /** Regions whose people this locale's names and addresses fit. */
  readonly regions: readonly CountryCode[];
}

/**
 * In the order used to break ties (after home regions and browser
 * languages). The id is Faker's locale id.
 */
export const LOCALES: readonly LocaleInfo[] = [
  { id: 'en_US', script: 'latin', regions: ['US'] },
  { id: 'en_GB', script: 'latin', regions: ['GB', 'IM', 'JE', 'GG'] },
  { id: 'en_CA', script: 'latin', regions: ['CA'] },
  { id: 'en_AU', script: 'latin', regions: ['AU'] },
  { id: 'en_IN', script: 'latin', regions: ['IN'] },
  { id: 'en_ZA', script: 'latin', regions: ['ZA'] },
  { id: 'en_NG', script: 'latin', regions: ['NG'] },
  { id: 'de', script: 'latin', regions: ['DE', 'AT'] },
  { id: 'fr', script: 'latin', regions: ['FR'] },
  { id: 'es', script: 'latin', regions: ['ES'] },
  { id: 'es_MX', script: 'latin', regions: ['MX'] },
  { id: 'it', script: 'latin', regions: ['IT'] },
  { id: 'pt_BR', script: 'latin', regions: ['BR'] },
  { id: 'nl', script: 'latin', regions: ['NL'] },
  { id: 'pl', script: 'latin', regions: ['PL'] },
  { id: 'sv', script: 'latin', regions: ['SE'] },
  { id: 'tr', script: 'latin', regions: ['TR'] },
  { id: 'id_ID', script: 'latin', regions: ['ID'] },
  { id: 'ru', script: 'cyrillic', regions: ['RU'] },
  { id: 'zh_CN', script: 'han', regions: ['CN'] },
  { id: 'ja', script: 'japanese', regions: ['JP'] },
  { id: 'ko', script: 'hangul', regions: ['KR'] },
  {
    id: 'ar',
    script: 'arabic',
    regions: [
      'AE',
      'BH',
      'DZ',
      'EG',
      'IQ',
      'JO',
      'KW',
      'LB',
      'LY',
      'MA',
      'OM',
      'QA',
      'SA',
      'SY',
      'TN',
      'YE',
    ],
  },
];

export type LocaleId = string;

const BY_ID = new Map(LOCALES.map((locale) => [locale.id, locale]));

export function localeInfo(id: LocaleId): LocaleInfo | undefined {
  return BY_ID.get(id);
}

/** The locale whose regions include `region`, if any. */
export function localeForRegion(region: CountryCode): LocaleInfo | undefined {
  return LOCALES.find((locale) => locale.regions.includes(region));
}

/** Used when nothing else points to a locale. */
export const DEFAULT_LOCALE = 'en_US';

/** The file name of the shared name index. */
export const NAME_INDEX = 'names';

/** True when names of `locale` can stand in for text written in `script`. */
export function fitsScript(locale: LocaleInfo, script: Script): boolean {
  if (locale.script === script) return true;
  // Japanese names are written with Han characters too.
  return script === 'han' && locale.script === 'japanese';
}
