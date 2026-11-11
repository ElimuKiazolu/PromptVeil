import type { CountryCode } from '../../shared/country.ts';
import type { EntitySubtype, EntityType } from '../../shared/entities.ts';
import type { Rng } from './rng.ts';

/** One real value to make a stand-in for (memory only). */
export interface StandInRequest {
  readonly type: EntityType;
  readonly subtype: EntitySubtype | null;
  readonly country: CountryCode | null;
  /** The real value as written. */
  readonly value: string;
  /** Its vault normal form. */
  readonly normalised: string;
  /** The conversation's date offset (birth dates inside IDs move by it). */
  readonly dateOffsetDays: number;
  /** The mapping's number in its conversation (the email stand-in shows it). */
  readonly number: number;
  /** Now, in ms (birth dates are never shifted into the future). */
  readonly now: number;
}

export interface StandIn {
  /** Written like the real value. */
  readonly value: string;
  /** The stand-in's vault normal form (compared with real values). */
  readonly normalised: string;
  /** True when it comes from a range reserved for fiction, tests or examples. */
  readonly reserved: boolean;
}

export interface GeneratorContext {
  readonly request: StandInRequest;
  /** Draws for this attempt. */
  readonly rng: Rng;
  /** Draws shared by every attempt of this value. */
  readonly base: Rng;
  readonly attempt: number;
  /** True while reserved ranges may be used (the first attempts). */
  readonly reservedAllowed: boolean;
}

export interface Generated {
  readonly value: string;
  readonly reserved: boolean;
}

/** A stand-in for the request, or null when this attempt has none. */
export type Generator = (context: GeneratorContext) => Generated | null;
