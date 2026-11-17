/**
 * EMAIL stand-ins: a realistic local part at a domain reserved for
 * documentation (RFC 2606: example.com, example.org, example.net), so a
 * stand-in can never deliver mail to anyone, even when the chatbot or one
 * of its tools sends email on its own. Deliberately unlike TR-S2, which
 * keeps public providers and invents plausible private domains.
 *
 * - Domain: every address at one real domain in a conversation gets the
 *   same reserved domain (the pipeline passes the one already used);
 *   otherwise one drawn from the seed, never the real domain itself.
 * - Local part, when the address belongs to a PERSON value: the same
 *   pattern with the person's stand-in (first.last, flast, first_last,
 *   lastf…), digits replaced by as many digits.
 * - Otherwise: given and family names known to the lists are replaced by
 *   names of the same kind (the locale and gender they suggest), role
 *   words (info, support, sales…) are kept, single letters and other words
 *   are replaced, digits too.
 */
import { isValidEmail } from '../detect/validators/email.ts';
import {
  emailDomain,
  LETTERS,
  LOCAL_TOKEN,
  localForm,
  nameUnits,
  splitAddress,
} from '../names/email-links.ts';
import { inCaseOf, lookUpName, nameParts } from '../names/parts.ts';
import { personLocale } from './person.ts';
import { DIGITS, LOWER, type Rng } from './rng.ts';
import type { NameIndex } from './words/format.ts';
import { genderOf, inferLocale, type ScoredPiece } from './words/infer.ts';
import type { LocaleId } from './words/locales.ts';
import { familyNames, givenNames, pickWord, wordsOf } from './words/pick.ts';
import type { Generator, PersonLink, StandInEnvironment } from './types.ts';

export const RESERVED_DOMAINS = ['example.com', 'example.org', 'example.net'];

/** Mailbox names that say what an address is for, not whose it is. */
const ROLE_WORDS = new Set([
  'accounts',
  'admin',
  'billing',
  'booking',
  'bookings',
  'careers',
  'contact',
  'enquiries',
  'feedback',
  'hello',
  'help',
  'hi',
  'hr',
  'info',
  'inquiries',
  'jobs',
  'mail',
  'marketing',
  'media',
  'news',
  'newsletter',
  'no',
  'noreply',
  'office',
  'orders',
  'postmaster',
  'press',
  'privacy',
  'reply',
  'reservations',
  'sales',
  'security',
  'service',
  'support',
  'team',
  'webmaster',
]);

/** Letter tokens as index lookups: given or family, whichever is listed. */
function scored(local: string, index: NameIndex | undefined): ScoredPiece[] {
  return (local.match(LOCAL_TOKEN) ?? []).flatMap((token): ScoredPiece[] => {
    if (!LETTERS.test(token)) return [];
    const hit = lookUpName(index, token);
    if (hit.given !== 0) return [{ text: token, role: 'given' }];
    if (hit.family !== 0) return [{ text: token, role: 'family' }];
    return [];
  });
}

/** The locale an EMAIL stand-in's names come from. */
export function emailLocale(
  value: string,
  person: PersonLink | undefined,
  index: NameIndex | undefined,
  preferred: readonly LocaleId[],
): LocaleId {
  if (person !== undefined) {
    return personLocale(person.standIn, index, preferred);
  }
  return inferLocale(
    'latin',
    scored(splitAddress(value).local, index),
    index,
    preferred,
  );
}

function digitsLike(rng: Rng, digits: string): string {
  return rng.chars(DIGITS, digits.length);
}

/** A name for a local part, never one to avoid. */
function localName(
  rng: Rng,
  list: readonly string[],
  avoid: Set<string>,
): string | null {
  const forms = list.map(localForm).filter((form) => form.length >= 2);
  const picked = pickWord(rng, forms, avoid);
  if (picked !== null) avoid.add(picked);
  return picked;
}

function localPart(
  local: string,
  rng: Rng,
  env: StandInEnvironment,
  person: PersonLink | undefined,
  attempt: number,
): string | null {
  const index = env.words.index();
  const locale = emailLocale(`${local}@x`, person, index, env.preferredLocales);
  const words = wordsOf(env, locale);
  const tokens = local.match(LOCAL_TOKEN) ?? [];
  const avoid = new Set(
    tokens.filter((token) => LETTERS.test(token)).map(localForm),
  );
  const realParts = person === undefined ? [] : nameParts(person.real);
  const standInParts = person === undefined ? [] : nameParts(person.standIn);
  const linked =
    realParts.length > 0 && realParts.length === standInParts.length;
  const firstGiven = tokens.find(
    (token) => LETTERS.test(token) && lookUpName(index, token).given !== 0,
  );
  const gender =
    firstGiven === undefined ? null : genderOf(index, locale, firstGiven);

  /** Name parts spelled out whole somewhere in the local part. */
  const spelled = new Set<number>();
  if (linked) {
    for (const token of tokens) {
      if (!LETTERS.test(token)) continue;
      for (const unit of nameUnits(localForm(token), realParts) ?? []) {
        if (!unit.initial) spelled.add(unit.part);
      }
    }
  }

  /** Tokens drawn at random (not kept, not the linked person's). */
  const drawn: string[] = [];
  const replace = (token: string): string | null => {
    if (!LETTERS.test(token)) {
      if (!/^\d+$/u.test(token)) return token;
      drawn.push(token);
      return digitsLike(rng, token);
    }
    const form = localForm(token);
    if (linked) {
      const units = nameUnits(form, realParts);
      if (units !== null) {
        return inCaseOf(
          token,
          units
            .map((unit) => {
              const name = localForm(standInParts[unit.part] ?? '');
              return unit.initial ? name.charAt(0) : name;
            })
            .join(''),
        );
      }
    }
    if (linked && form.length === 1) {
      // An initial next to a spelled name part ("harriet_p").
      const part = realParts.findIndex(
        (name, i) =>
          localForm(name).startsWith(form) &&
          !spelled.has(i) &&
          localForm(standInParts[i] ?? '') !== '',
      );
      const standIn = standInParts[part];
      if (standIn !== undefined) {
        return inCaseOf(token, localForm(standIn).charAt(0));
      }
    }
    if (ROLE_WORDS.has(form)) return token;
    drawn.push(token);
    if (form.length <= 3 && lookUpName(index, token).given === 0) {
      // A short unknown token: letters of the same length.
      let letters = form;
      while (letters === form) letters = rng.chars(LOWER, form.length);
      return inCaseOf(token, letters);
    }
    if (form.length === 1) {
      let letter = form;
      while (letter === form) letter = rng.char(LOWER);
      return inCaseOf(token, letter);
    }
    const hit = lookUpName(index, token);
    const list =
      hit.given !== 0 && hit.family === 0
        ? givenNames(words, gender)
        : familyNames(words, null);
    const name = localName(rng, list, avoid);
    return name === null ? null : inCaseOf(token, name);
  };

  let out = '';
  for (const token of tokens) {
    const next = replace(token);
    if (next === null) return null;
    out += next;
  }
  // Nothing drawn (role words, or the linked person's pattern): later
  // attempts add digits, so a taken stand-in still has others to try.
  if (drawn.length === 0 && attempt > 0) out += rng.chars(DIGITS, 2);
  return out;
}

/** The reserved domain for a real one: the linked one, else from the seed. */
function domainFor(real: string, rng: Rng, linked: string | undefined): string {
  if (linked !== undefined) return linked;
  const lower = real.toLowerCase();
  const choices = RESERVED_DOMAINS.filter((domain) => domain !== lower);
  return rng.pick(choices);
}

export const emailStandIn: Generator = ({
  request,
  rng,
  base,
  env,
  attempt,
}) => {
  const { local, domain } = splitAddress(request.value);
  const standInLocal = localPart(
    local,
    rng,
    env,
    request.links?.person,
    attempt,
  );
  if (standInLocal === null || standInLocal === '') return null;
  return {
    value: `${standInLocal}@${domainFor(domain, base, request.links?.domain)}`,
    reserved: true,
    locale: emailLocale(
      request.value,
      request.links?.person,
      env.words.index(),
      env.preferredLocales,
    ),
  };
};

/** A valid address at a reserved domain. */
export function isWellFormedEmailStandIn(standIn: string): boolean {
  return (
    isValidEmail(standIn) && RESERVED_DOMAINS.includes(emailDomain(standIn))
  );
}
