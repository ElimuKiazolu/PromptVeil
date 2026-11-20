/**
 * The locales of the bundled word lists (public/data/<id>.json, built by
 * scripts/build-wordlists.ts from Faker's locale definitions and the open
 * data in opendata/), with the script their names are written in and the
 * regions they stand for.
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
  /** Faker's locale its lists start from, or null (open data only). */
  readonly faker: string | null;
}

/**
 * In the order used to break ties (after home regions and browser
 * languages). The id is Faker's locale id where Faker has one; en_SG
 * (Singapore) and zh_Latn (Chinese names in Hanyu Pinyin) come from open
 * data only. At most 31 (the name index's bit masks).
 */
export const LOCALES: readonly LocaleInfo[] = [
  { id: 'en_US', script: 'latin', regions: ['US'], faker: 'en_US' },
  {
    id: 'en_GB',
    script: 'latin',
    regions: ['GB', 'IM', 'JE', 'GG'],
    faker: 'en_GB',
  },
  { id: 'en_CA', script: 'latin', regions: ['CA'], faker: 'en_CA' },
  { id: 'en_AU', script: 'latin', regions: ['AU'], faker: 'en_AU' },
  { id: 'en_IN', script: 'latin', regions: ['IN'], faker: 'en_IN' },
  { id: 'en_ZA', script: 'latin', regions: ['ZA'], faker: 'en_ZA' },
  { id: 'en_NG', script: 'latin', regions: ['NG'], faker: 'en_NG' },
  { id: 'zh_Latn', script: 'latin', regions: [], faker: null },
  { id: 'en_SG', script: 'latin', regions: ['SG'], faker: null },
  { id: 'de', script: 'latin', regions: ['DE', 'AT'], faker: 'de' },
  { id: 'fr', script: 'latin', regions: ['FR'], faker: 'fr' },
  { id: 'es', script: 'latin', regions: ['ES'], faker: 'es' },
  { id: 'es_MX', script: 'latin', regions: ['MX'], faker: 'es_MX' },
  { id: 'it', script: 'latin', regions: ['IT'], faker: 'it' },
  { id: 'pt_BR', script: 'latin', regions: ['BR'], faker: 'pt_BR' },
  { id: 'nl', script: 'latin', regions: ['NL'], faker: 'nl' },
  { id: 'pl', script: 'latin', regions: ['PL'], faker: 'pl' },
  { id: 'sv', script: 'latin', regions: ['SE'], faker: 'sv' },
  { id: 'tr', script: 'latin', regions: ['TR'], faker: 'tr' },
  { id: 'id_ID', script: 'latin', regions: ['ID'], faker: 'id_ID' },
  { id: 'ru', script: 'cyrillic', regions: ['RU'], faker: 'ru' },
  { id: 'zh_CN', script: 'han', regions: ['CN'], faker: 'zh_CN' },
  { id: 'ja', script: 'japanese', regions: ['JP'], faker: 'ja' },
  { id: 'ko', script: 'hangul', regions: ['KR'], faker: 'ko' },
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
    faker: 'ar',
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
