/**
 * Month names of the languages the date-of-birth rule reads (the context
 * words' languages): full names and common abbreviations, plus spellings
 * without accents or with alternative abbreviations.
 */

export const MONTH_LANGUAGES = ['en', 'de', 'fr', 'es', 'it', 'pt'] as const;

export type MonthLanguage = (typeof MONTH_LANGUAGES)[number];

export type MonthForm = 'full' | 'abbr';

interface MonthNames {
  readonly full: readonly string[];
  readonly abbr: readonly string[];
  /** Other spellings: [spelling, month, form]. */
  readonly other: readonly (readonly [string, number, MonthForm])[];
}

const NAMES: Record<MonthLanguage, MonthNames> = {
  en: {
    full: [
      'january',
      'february',
      'march',
      'april',
      'may',
      'june',
      'july',
      'august',
      'september',
      'october',
      'november',
      'december',
    ],
    abbr: [
      'jan',
      'feb',
      'mar',
      'apr',
      'may',
      'jun',
      'jul',
      'aug',
      'sep',
      'oct',
      'nov',
      'dec',
    ],
    other: [['sept', 9, 'abbr']],
  },
  de: {
    full: [
      'januar',
      'februar',
      'märz',
      'april',
      'mai',
      'juni',
      'juli',
      'august',
      'september',
      'oktober',
      'november',
      'dezember',
    ],
    abbr: [
      'jan',
      'feb',
      'mär',
      'apr',
      'mai',
      'jun',
      'jul',
      'aug',
      'sep',
      'okt',
      'nov',
      'dez',
    ],
    other: [
      ['jänner', 1, 'full'],
      ['jän', 1, 'abbr'],
      ['maerz', 3, 'full'],
      ['marz', 3, 'full'],
      ['mrz', 3, 'abbr'],
      ['sept', 9, 'abbr'],
    ],
  },
  fr: {
    full: [
      'janvier',
      'février',
      'mars',
      'avril',
      'mai',
      'juin',
      'juillet',
      'août',
      'septembre',
      'octobre',
      'novembre',
      'décembre',
    ],
    abbr: [
      'janv',
      'févr',
      'mars',
      'avr',
      'mai',
      'juin',
      'juil',
      'août',
      'sept',
      'oct',
      'nov',
      'déc',
    ],
    other: [
      ['fevrier', 2, 'full'],
      ['aout', 8, 'full'],
      ['decembre', 12, 'full'],
      ['fevr', 2, 'abbr'],
      ['fév', 2, 'abbr'],
      ['fev', 2, 'abbr'],
      ['dec', 12, 'abbr'],
    ],
  },
  es: {
    full: [
      'enero',
      'febrero',
      'marzo',
      'abril',
      'mayo',
      'junio',
      'julio',
      'agosto',
      'septiembre',
      'octubre',
      'noviembre',
      'diciembre',
    ],
    abbr: [
      'ene',
      'feb',
      'mar',
      'abr',
      'may',
      'jun',
      'jul',
      'ago',
      'sep',
      'oct',
      'nov',
      'dic',
    ],
    other: [
      ['setiembre', 9, 'full'],
      ['sept', 9, 'abbr'],
    ],
  },
  it: {
    full: [
      'gennaio',
      'febbraio',
      'marzo',
      'aprile',
      'maggio',
      'giugno',
      'luglio',
      'agosto',
      'settembre',
      'ottobre',
      'novembre',
      'dicembre',
    ],
    abbr: [
      'gen',
      'feb',
      'mar',
      'apr',
      'mag',
      'giu',
      'lug',
      'ago',
      'set',
      'ott',
      'nov',
      'dic',
    ],
    other: [],
  },
  pt: {
    full: [
      'janeiro',
      'fevereiro',
      'março',
      'abril',
      'maio',
      'junho',
      'julho',
      'agosto',
      'setembro',
      'outubro',
      'novembro',
      'dezembro',
    ],
    abbr: [
      'jan',
      'fev',
      'mar',
      'abr',
      'mai',
      'jun',
      'jul',
      'ago',
      'set',
      'out',
      'nov',
      'dez',
    ],
    other: [['marco', 3, 'full']],
  },
};

/** One reading of a month word. */
export interface MonthWord {
  readonly language: MonthLanguage;
  readonly month: number;
  readonly form: MonthForm;
  /** Written without the accents its language's spelling has. */
  readonly plain: boolean;
}

const stripAccents = (text: string): string =>
  text.normalize('NFD').replace(/\p{M}/gu, '');

const BY_SPELLING = new Map<string, MonthWord[]>();
function addSpelling(spelling: string, word: MonthWord): void {
  BY_SPELLING.set(spelling, [...(BY_SPELLING.get(spelling) ?? []), word]);
}
for (const language of MONTH_LANGUAGES) {
  const names = NAMES[language];
  const forms: readonly [MonthForm, readonly string[]][] = [
    ['full', names.full],
    ['abbr', names.abbr],
  ];
  for (const [form, list] of forms) {
    for (const [index, name] of list.entries()) {
      addSpelling(name, { language, month: index + 1, form, plain: false });
    }
  }
  for (const [spelling, month, form] of names.other) {
    const plain = stripAccents(spelling) === spelling;
    addSpelling(spelling, { language, month, form, plain });
  }
}

/** Every reading of a month word (any case), best first, or none. */
export function monthWords(word: string): readonly MonthWord[] {
  const found = BY_SPELLING.get(word.toLowerCase()) ?? [];
  // A full name before an abbreviation that happens to look the same.
  return [...found].sort(
    (a, b) => Number(a.form === 'abbr') - Number(b.form === 'abbr'),
  );
}

/** Every spelling, longest first (for building a pattern). */
export const MONTH_SPELLINGS: readonly string[] = [...BY_SPELLING.keys()].sort(
  (a, b) => b.length - a.length || a.localeCompare(b),
);

/** The month's name in a language and form, lower case. */
export function monthName(
  language: MonthLanguage,
  month: number,
  form: MonthForm,
  plain: boolean,
): string {
  const names = NAMES[language];
  const name = (form === 'full' ? names.full : names.abbr)[month - 1] ?? '';
  return plain ? stripAccents(name) : name;
}
