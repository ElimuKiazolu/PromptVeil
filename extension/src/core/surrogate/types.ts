import type { CountryCode } from '../../shared/country.ts';
import type { EntitySubtype, EntityType } from '../../shared/entities.ts';
import type { Rng } from './rng.ts';
import type { LocaleId } from './words/locales.ts';
import type { WordLists } from './words/store.ts';

/** A PERSON value and its stand-in (memory only). */
export interface PersonLink {
  readonly real: string;
  readonly standIn: string;
}

/** Other values a stand-in must agree with (memory only). */
export interface StandInLinks {
  /** EMAIL: the person the address belongs to; its local part follows. */
  readonly person?: PersonLink;
  /** EMAIL: the stand-in domain already used for this real domain. */
  readonly domain?: string;
}

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
  /** The mapping's number in its conversation. */
  readonly number: number;
  /** Now, in ms (birth dates are never shifted into the future). */
  readonly now: number;
  readonly links?: StandInLinks;
}

/** What generators may read besides the request. */
export interface StandInEnvironment {
  /** Word lists loaded so far (the pipeline loads what a send needs). */
  readonly words: WordLists;
  /** Locales of the home regions, then of the browser languages' regions. */
  readonly preferredLocales: readonly LocaleId[];
  /** ADDRESS: keep the city (settings.keepCity). */
  readonly keepCity: boolean;
}

export interface StandIn {
  /** Written like the real value. */
  readonly value: string;
  /** The stand-in's vault normal form (compared with real values). */
  readonly normalised: string;
  /** True when it comes from a range reserved for fiction, tests or examples. */
  readonly reserved: boolean;
  /** The word-list locale it was drawn from, if any. */
  readonly locale: LocaleId | null;
  /**
   * CARD: a published test number of a related brand, the value's own
   * brand and length being used up in the conversation.
   */
  readonly fallback?: boolean;
  /**
   * Stored as the mapping's variants: PERSON, the stand-in's name parts (see
   * nameParts); DOB, its day/month order; else empty.
   */
  readonly parts: readonly string[];
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
  readonly env: StandInEnvironment;
}

export interface Generated {
  readonly value: string;
  readonly reserved: boolean;
  readonly locale?: LocaleId;
  /**
   * The stand-in's normal form, when the generator knows it better than the
   * real value's rules would read it (a date read in the real date's order).
   */
  readonly normalised?: string;
  /** Stand-in-side facts stored with it (DOB: its day/month order). */
  readonly parts?: readonly string[];
  /** Borrowed from a related format, the value's own being used up. */
  readonly fallback?: boolean;
}

/** A stand-in for the request, or null when this attempt has none. */
export type Generator = (context: GeneratorContext) => Generated | null;
