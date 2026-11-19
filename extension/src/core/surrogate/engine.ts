/**
 * The stand-in engine: one stand-in per (seed, attempt), deterministic.
 *
 * Attempt 0 is the value's first choice; the masker moves to the next
 * attempt when a stand-in collides (with a stored stand-in, a real value of
 * the conversation, or text in the prompt). The first RESERVED_ATTEMPTS take
 * stand-ins from ranges reserved for fiction, tests or examples where the
 * type has one; later attempts give random values of the right format and
 * checksum.
 *
 * Every stand-in is checked here before it is returned: it must pass its
 * type's format and checksum checks (a never-issued range passes these but
 * not the detector's issuance rules), differ from the real value, and its
 * normal form is computed with the same rules as real values'.
 *
 * PERSON, ORG, ADDRESS and EMAIL draw from the word lists: the caller loads
 * the files `wordListsFor` names first (generation is synchronous; a list
 * that is not loaded throws, so the send is blocked).
 */
import { normaliseReal } from '../detect/normal-form.ts';
import {
  COUNTRY_PACKS,
  type StandInSpec,
} from '../detect/rules/packs/index.ts';
import { validateCard } from '../detect/validators/card.ts';
import { validateIban } from '../detect/validators/iban.ts';
import type { EntitySubtype, EntityType } from '../../shared/entities.ts';
import {
  addressLocale,
  addressStandIn,
  isWellFormedAddressStandIn,
} from './address.ts';
import { cardStandIn } from './card.ts';
import { cryptoStandIn, isWellFormedCryptoStandIn } from './crypto.ts';
import {
  emailLocale,
  emailStandIn,
  isWellFormedEmailStandIn,
} from './email.ts';
import { ibanStandIn } from './iban.ts';
import { ipStandIn, isWellFormedIpStandIn } from './ip.ts';
import { nationalIdStandIn } from './national-id.ts';
import { nameParts } from '../names/parts.ts';
import { isWellFormedOrgStandIn, orgLocale, orgStandIn } from './org.ts';
import {
  isWellFormedPersonStandIn,
  personLocale,
  personStandIn,
} from './person.ts';
import { isWellFormedPhoneStandIn, phoneStandIn } from './phone.ts';
import { createRng } from './rng.ts';
import { isWellFormedSecretStandIn, secretStandIn } from './secret.ts';
import type {
  Generator,
  StandIn,
  StandInEnvironment,
  StandInRequest,
} from './types.ts';
import type { LocaleId } from './words/locales.ts';
import { fixedWordLists } from './words/store.ts';

/** Attempts that may use reserved ranges, before random values. */
export const RESERVED_ATTEMPTS = 8;

/** Thrown for a value whose type has no stand-in generator yet. */
export class StandInError extends Error {
  constructor() {
    super('unsupported');
    this.name = 'StandInError';
  }
}

const SPECS = new Map<EntitySubtype, StandInSpec>();
for (const pack of COUNTRY_PACKS) {
  for (const [subtype, spec] of Object.entries(pack.standIns)) {
    SPECS.set(subtype as EntitySubtype, spec);
  }
}

/** No word lists: for types that need none. */
export const NO_WORDS: StandInEnvironment = {
  words: fixedWordLists(undefined, []),
  preferredLocales: [],
  keepCity: true,
};

/** Types whose stand-ins come from the word lists. */
export const WORD_TYPES: ReadonlySet<EntityType> = new Set<EntityType>([
  'PERSON',
  'ORG',
  'ADDRESS',
  'EMAIL',
]);

/**
 * The locale file a stand-in for the request draws from (the name index
 * must be loaded first: it decides the locale), or null for types that use
 * no word lists.
 */
export function wordListFor(
  request: Pick<StandInRequest, 'type' | 'value' | 'country' | 'links'>,
  env: StandInEnvironment,
): LocaleId | null {
  const index = env.words.index();
  const preferred = env.preferredLocales;
  switch (request.type) {
    case 'PERSON':
      return personLocale(request.value, index, preferred);
    case 'ORG':
      return orgLocale(request.value, index, preferred);
    case 'ADDRESS':
      return addressLocale(request.value, request.country, preferred);
    case 'EMAIL':
      return emailLocale(
        request.value,
        request.links?.person,
        index,
        preferred,
      );
    default:
      return null;
  }
}

function generatorFor(request: StandInRequest): Generator {
  switch (request.type) {
    case 'PERSON':
      return personStandIn;
    case 'ORG':
      return orgStandIn;
    case 'ADDRESS':
      return addressStandIn;
    case 'EMAIL':
      return emailStandIn;
    case 'PHONE':
      return phoneStandIn;
    case 'CARD':
      return cardStandIn;
    case 'BANK':
      if (request.subtype === 'IBAN') return ibanStandIn;
      break;
    case 'SECRET':
      return secretStandIn;
    case 'IP':
      return ipStandIn;
    case 'CRYPTO':
      return cryptoStandIn;
    case 'NATIONAL_ID':
      if (request.subtype !== null && SPECS.has(request.subtype)) {
        return nationalIdStandIn;
      }
      break;
    default:
      break;
  }
  throw new StandInError();
}

/** The format and checksum check of the stand-in's type. */
export function isWellFormedStandIn(
  request: StandInRequest,
  standIn: string,
  env: StandInEnvironment = NO_WORDS,
): boolean {
  switch (request.type) {
    case 'PERSON':
      return isWellFormedPersonStandIn(standIn, request.value);
    case 'ORG':
      return isWellFormedOrgStandIn(standIn, request.value, env.words.index());
    case 'ADDRESS':
      return isWellFormedAddressStandIn(standIn, request.value);
    case 'EMAIL':
      return isWellFormedEmailStandIn(standIn);
    case 'PHONE':
      return isWellFormedPhoneStandIn(standIn, request.value, request.country);
    case 'CARD': {
      const real = validateCard(request.value);
      const candidate = validateCard(standIn);
      return real.valid && candidate.valid && candidate.brand === real.brand;
    }
    case 'BANK': {
      const real = validateIban(request.value);
      const candidate = validateIban(standIn);
      return (
        real.valid && candidate.valid && candidate.country === real.country
      );
    }
    case 'SECRET':
      return isWellFormedSecretStandIn(standIn, request.value);
    case 'IP':
      return isWellFormedIpStandIn(standIn, request.value);
    case 'CRYPTO':
      return isWellFormedCryptoStandIn(standIn, request.value);
    case 'NATIONAL_ID': {
      const spec =
        request.subtype === null ? undefined : SPECS.get(request.subtype);
      return spec?.isWellFormed(standIn) ?? false;
    }
    default:
      return false;
  }
}

/**
 * The stand-in for this attempt, or null when the attempt has none (the
 * masker then tries the next one). Throws StandInError for a type without a
 * generator, WordListError when a word list it needs is not loaded.
 */
export function generateStandIn(
  request: StandInRequest,
  seed: Uint8Array,
  attempt: number,
  env: StandInEnvironment = NO_WORDS,
): StandIn | null {
  const generator = generatorFor(request);
  const generated = generator({
    request,
    rng: createRng(seed, `attempt:${attempt.toString()}`),
    base: createRng(seed, 'base'),
    attempt,
    reservedAllowed: attempt < RESERVED_ATTEMPTS,
    env,
  });
  if (generated === null || generated.value === request.value) return null;
  if (!isWellFormedStandIn(request, generated.value, env)) return null;
  const normalised = normaliseReal(
    request.type,
    request.subtype,
    request.country,
    generated.value,
  );
  if (normalised === request.normalised) return null;
  return {
    value: generated.value,
    normalised,
    reserved: generated.reserved,
    locale: generated.locale ?? null,
    parts: request.type === 'PERSON' ? nameParts(generated.value) : [],
  };
}
