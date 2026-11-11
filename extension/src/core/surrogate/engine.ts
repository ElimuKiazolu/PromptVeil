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
 */
import { normaliseReal } from '../detect/normal-form.ts';
import {
  COUNTRY_PACKS,
  type StandInSpec,
} from '../detect/rules/packs/index.ts';
import { validateCard } from '../detect/validators/card.ts';
import { isValidEmail } from '../detect/validators/email.ts';
import { validateIban } from '../detect/validators/iban.ts';
import { isSpikeStandIn } from '../spike-standin.ts';
import type { EntitySubtype } from '../../shared/entities.ts';
import { cardStandIn } from './card.ts';
import { emailStandIn } from './email.ts';
import { ibanStandIn } from './iban.ts';
import { nationalIdStandIn } from './national-id.ts';
import { isWellFormedPhoneStandIn, phoneStandIn } from './phone.ts';
import { createRng } from './rng.ts';
import { isWellFormedSecretStandIn, secretStandIn } from './secret.ts';
import type { Generator, StandIn, StandInRequest } from './types.ts';

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

function generatorFor(request: StandInRequest): Generator {
  switch (request.type) {
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
): boolean {
  switch (request.type) {
    case 'EMAIL':
      return isValidEmail(standIn) && isSpikeStandIn(standIn);
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
 * generator.
 */
export function generateStandIn(
  request: StandInRequest,
  seed: Uint8Array,
  attempt: number,
): StandIn | null {
  const generator = generatorFor(request);
  const generated = generator({
    request,
    rng: createRng(seed, `attempt:${attempt.toString()}`),
    base: createRng(seed, 'base'),
    attempt,
    reservedAllowed: attempt < RESERVED_ATTEMPTS,
  });
  if (generated === null || generated.value === request.value) return null;
  if (!isWellFormedStandIn(request, generated.value)) return null;
  const normalised = normaliseReal(
    request.type,
    request.subtype,
    request.country,
    generated.value,
  );
  if (normalised === request.normalised) return null;
  return { value: generated.value, normalised, reserved: generated.reserved };
}
