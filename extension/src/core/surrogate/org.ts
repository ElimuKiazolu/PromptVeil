/**
 * ORG stand-ins (TR-S2): the legal suffix (Ltd, GmbH, S.p.A., Pvt Ltd…) and
 * the words that say what kind of organisation it is (University, Hospital,
 * Bank, of, &…) stay as written; the words that name it are replaced:
 * a place after "of"/"de"/"di" in an institution's name by a locality, an
 * acronym by capitals of the same length, digits by digits, other words by
 * family names (the commonest way companies are named), in the same case
 * style. Locale: the legal suffix's, the institution word's language, else
 * the names'.
 *
 * A CJK name without spaces keeps its legal suffix (有限公司, 株式会社) and
 * gets a family and a given name in place of the rest.
 */
import { CJK, inCaseOf, lookUpName } from '../names/parts.ts';
import { DIGITS, UPPER, type Rng } from './rng.ts';
import type { NameIndex } from './words/format.ts';
import { inferLocale, preferredIn } from './words/infer.ts';
import { scriptOf, type LocaleId } from './words/locales.ts';
import { familyNames, givenNames, pickWord, wordsOf } from './words/pick.ts';
import type { Generator, StandInEnvironment } from './types.ts';

/** Legal forms beyond the word lists' (TR-S2's list and common others). */
const LEGAL_FORMS: readonly (readonly [string, LocaleId | null])[] = [
  ['Ltd', null],
  ['Ltd.', null],
  ['Limited', null],
  ['Inc', 'en_US'],
  ['Inc.', 'en_US'],
  ['Incorporated', 'en_US'],
  ['LLC', 'en_US'],
  ['L.L.C.', 'en_US'],
  ['LLP', null],
  ['PLC', 'en_GB'],
  ['plc', 'en_GB'],
  ['Corp', null],
  ['Corp.', null],
  ['Corporation', null],
  ['Co.', null],
  ['& Co.', null],
  ['Pvt Ltd', 'en_IN'],
  ['Pvt. Ltd.', 'en_IN'],
  ['Private Limited', 'en_IN'],
  ['Pty Ltd', 'en_AU'],
  ['Pty. Ltd.', 'en_AU'],
  ['GmbH', 'de'],
  ['gGmbH', 'de'],
  ['AG', 'de'],
  ['e.V.', 'de'],
  ['S.A.', null],
  ['SA', null],
  ['S.L.', 'es'],
  ['SL', 'es'],
  ['S.A.S.', 'fr'],
  ['SAS', 'fr'],
  ['SARL', 'fr'],
  ['S.p.A.', 'it'],
  ['SpA', 'it'],
  ['S.r.l.', 'it'],
  ['Srl', 'it'],
  ['Ltda', 'pt_BR'],
  ['Ltda.', 'pt_BR'],
  ['B.V.', 'nl'],
  ['N.V.', 'nl'],
  ['Sp. z o.o.', 'pl'],
  ['A.Ş.', 'tr'],
];

/** Words naming the kind of organisation; kept. Some show the language. */
const KIND_WORDS = new Map<string, LocaleId | null>([
  ...[
    'academy',
    'agency',
    'association',
    'associates',
    'bank',
    'brothers',
    'center',
    'centre',
    'church',
    'central',
    'clinic',
    'co',
    'community',
    'college',
    'company',
    'consulting',
    'corporation',
    'council',
    'foundation',
    'general',
    'global',
    'group',
    'holdings',
    'hospital',
    'institute',
    'international',
    'laboratories',
    'labs',
    'medical',
    'memorial',
    'national',
    'partners',
    'regional',
    'royal',
    'school',
    'services',
    'society',
    'solutions',
    'sons',
    'systems',
    'technologies',
    'trust',
    'university',
  ].map((word) => [word, null] as const),
  ['universität', 'de'],
  ['hochschule', 'de'],
  ['klinikum', 'de'],
  ['krankenhaus', 'de'],
  ['stiftung', 'de'],
  ['verein', 'de'],
  ['gruppe', 'de'],
  ['gesellschaft', 'de'],
  ['université', 'fr'],
  ['hôpital', 'fr'],
  ['banque', 'fr'],
  ['école', 'fr'],
  ['institut', 'fr'],
  ['fondation', 'fr'],
  ['clinique', 'fr'],
  ['groupe', 'fr'],
  ['société', 'fr'],
  ['compagnie', 'fr'],
  ['universidad', 'es'],
  ['banco', null],
  ['fundación', 'es'],
  ['instituto', null],
  ['colegio', 'es'],
  ['grupo', null],
  ['compañía', 'es'],
  ['hermanos', 'es'],
  ['hijos', 'es'],
  ['università', 'it'],
  ['ospedale', 'it'],
  ['banca', 'it'],
  ['istituto', 'it'],
  ['fondazione', 'it'],
  ['gruppo', 'it'],
  ['figli', 'it'],
  ['universidade', 'pt_BR'],
  ['fundação', 'pt_BR'],
  ['companhia', 'pt_BR'],
  ['universiteit', 'nl'],
  ['ziekenhuis', 'nl'],
  ['stichting', 'nl'],
  ['groep', 'nl'],
  ['zonen', 'nl'],
  ['uniwersytet', 'pl'],
  ['szpital', 'pl'],
  ['fundacja', 'pl'],
  ['grupa', 'pl'],
  ['universitet', 'sv'],
  ['sjukhus', 'sv'],
  ['stiftelse', 'sv'],
  ['gruppen', 'sv'],
]);

/** Joining words; kept. Those before a place are in PLACE_BEFORE. */
const JOINERS = new Set([
  '&',
  'and',
  'the',
  'for',
  'und',
  'für',
  'et',
  'y',
  'e',
  'och',
  'i',
  'van',
  'voor',
  'la',
  'le',
  'el',
  'il',
  'der',
  'die',
  'das',
]);
const PLACE_BEFORE = new Set([
  'of',
  'de',
  'del',
  'des',
  'di',
  'da',
  'do',
  'du',
  'in',
  'zu',
  'w',
]);

const WORD = /[^\s,]+/gu;
const ACRONYM = /^[A-Z]{2,6}$/u;

interface Suffix {
  readonly start: number;
  readonly end: number;
  readonly locale: LocaleId | null;
}

function suffixCandidates(
  index: NameIndex | undefined,
  preferred: readonly LocaleId[],
): (readonly [string, LocaleId | null])[] {
  const out: (readonly [string, LocaleId | null])[] = [...LEGAL_FORMS];
  for (const [suffix, mask] of index?.legal ?? []) {
    out.push([suffix, preferredIn(index, mask, preferred)]);
  }
  // The longest first, so "GmbH & Co. KG" wins over "KG".
  return out.sort((a, b) => b[0].length - a[0].length);
}

/** The legal form at the end (or, e.g. ООО, 株式会社, at the start). */
function findSuffix(
  value: string,
  index: NameIndex | undefined,
  preferred: readonly LocaleId[],
): Suffix | null {
  const glued = CJK.has(scriptOf(value));
  const lower = value.toLowerCase();
  for (const [suffix, locale] of suffixCandidates(index, preferred)) {
    const form = suffix.toLowerCase();
    if (lower.endsWith(form)) {
      const start = value.length - form.length;
      const before = value.charAt(start - 1);
      if (start > 0 && (glued || /[\s,]/u.test(before))) {
        return { start, end: value.length, locale };
      }
    }
    if (lower.startsWith(form)) {
      const after = value.charAt(form.length);
      if (form.length < value.length && (glued || /\s/u.test(after))) {
        return { start: 0, end: form.length, locale };
      }
    }
  }
  return null;
}

interface OrgPlan {
  readonly suffix: Suffix | null;
  readonly words: readonly { start: number; end: number; text: string }[];
  readonly locale: LocaleId;
}

function planOrg(
  value: string,
  index: NameIndex | undefined,
  preferred: readonly LocaleId[],
): OrgPlan {
  const suffix = findSuffix(value, index, preferred);
  const words = [...value.matchAll(WORD)]
    .map((match) => ({
      start: match.index,
      end: match.index + match[0].length,
      text: match[0],
    }))
    .filter(
      (word) =>
        suffix === null || word.end <= suffix.start || word.start >= suffix.end,
    );
  const kind = words
    .map((word) => KIND_WORDS.get(word.text.toLowerCase()))
    .find((locale) => locale !== undefined && locale !== null);
  const locale =
    suffix?.locale ??
    kind ??
    inferLocale(
      scriptOf(value),
      words
        .filter((word) => lookUpName(index, word.text).family !== 0)
        .map((word) => ({ text: word.text, role: 'family' as const })),
      index,
      preferred,
    );
  return { suffix, words, locale };
}

/** The locale an ORG stand-in for `value` comes from. */
export function orgLocale(
  value: string,
  index: NameIndex | undefined,
  preferred: readonly LocaleId[],
): LocaleId {
  return planOrg(value, index, preferred).locale;
}

function digitsLike(rng: Rng, text: string): string {
  return text.replace(/\d/gu, () => rng.char(DIGITS));
}

function acronymLike(rng: Rng, text: string): string {
  let out = text;
  while (out === text) out = rng.chars(UPPER, text.length);
  return out;
}

/** The stand-in for an organisation's name, or null if none was found. */
export function orgName(
  value: string,
  rng: Rng,
  env: StandInEnvironment,
): { value: string; locale: LocaleId } | null {
  const index = env.words.index();
  const plan = planOrg(value, index, env.preferredLocales);
  const words = wordsOf(env, plan.locale);
  const avoid = new Set(plan.words.map((word) => word.text.toLowerCase()));
  const family = familyNames(words, null);

  if (CJK.has(scriptOf(value)) && plan.words.length <= 1) {
    const name =
      plan.suffix === null ? value : value.slice(0, plan.suffix.start);
    const head =
      plan.suffix?.start === 0 ? value.slice(0, plan.suffix.end) : '';
    const body = plan.suffix?.start === 0 ? value.slice(plan.suffix.end) : name;
    const familyName = pickWord(rng, family, avoid);
    const given = pickWord(rng, givenNames(words, null), avoid);
    if (familyName === null || given === null) return null;
    const tail =
      plan.suffix !== null && plan.suffix.start > 0
        ? value.slice(plan.suffix.start)
        : '';
    return body === ''
      ? null
      : { value: head + familyName + given + tail, locale: plan.locale };
  }

  const institution = plan.words.some((word) =>
    KIND_WORDS.has(word.text.toLowerCase()),
  );
  let out = '';
  let cursor = 0;
  let replaced = 0;
  let previous = '';
  for (const word of plan.words) {
    out += value.slice(cursor, word.start);
    cursor = word.end;
    const lower = word.text.toLowerCase();
    const possessive = /['’]s$/u.exec(word.text)?.[0] ?? '';
    const stem = word.text.slice(0, word.text.length - possessive.length);
    let replacement: string | null;
    if (
      KIND_WORDS.has(lower) ||
      JOINERS.has(lower) ||
      PLACE_BEFORE.has(lower)
    ) {
      replacement = word.text;
    } else if (/\d/u.test(stem)) {
      replacement = digitsLike(rng, word.text);
    } else if (ACRONYM.test(stem)) {
      replacement = acronymLike(rng, stem) + possessive;
    } else {
      const place = institution && PLACE_BEFORE.has(previous);
      const list =
        place && words.localities.length > 0 ? words.localities : family;
      const picked = pickWord(
        rng,
        list.filter((item) => !/\s/u.test(item)),
        avoid,
      );
      if (picked === null) return null;
      avoid.add(picked.toLowerCase());
      replacement = inCaseOf(stem, picked) + possessive;
    }
    if (replacement !== word.text) replaced += 1;
    out += replacement;
    previous = lower;
  }
  out += value.slice(cursor);
  if (replaced === 0) {
    // Only kind words and a suffix ("University Hospital"): a name goes first.
    const picked = pickWord(rng, family, avoid);
    if (picked === null) return null;
    out = `${picked} ${out}`;
  }
  return { value: out, locale: plan.locale };
}

export const orgStandIn: Generator = ({ request, rng, env }) => {
  const name = orgName(request.value, rng, env);
  return name === null
    ? null
    : { value: name.value, reserved: false, locale: name.locale };
};

/** Keeps the real value's legal form, where it was. */
export function isWellFormedOrgStandIn(
  standIn: string,
  real: string,
  index: NameIndex | undefined,
): boolean {
  const suffix = findSuffix(real, index, []);
  if (suffix === null) return standIn.trim() !== '';
  const form = real.slice(suffix.start, suffix.end).toLowerCase();
  return suffix.start === 0
    ? standIn.toLowerCase().startsWith(form)
    : standIn.toLowerCase().endsWith(form);
}
