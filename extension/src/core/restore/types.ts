/**
 * How a stand-in must be delimited in text for a match to count.
 * - 'email': not glued to further local-part or domain characters, so
 *   "xstandin.1@example.net.au" does not contain "standin.1@example.net".
 * - 'word': not glued to further letters, digits or underscores.
 */
export type BoundaryRule = 'email' | 'word';

/** One stand-in shown to the chatbot and the real value it replaced. */
export interface StandInMapping {
  readonly standIn: string;
  readonly real: string;
  readonly boundary: BoundaryRule;
  /**
   * Compact forms of the real value the request safety net looks for (see
   * src/core/net/forms.ts); when absent, the compact form of `real`.
   */
  readonly netForms?: readonly string[];
  /**
   * Other writings of the stand-in that restore too (TR-X2), see
   * variants.ts. Without it, only the stand-in as shown (any case) restores.
   */
  readonly variants?: StandInVariants;
}

/**
 * How else a stand-in may come back in a reply.
 * - 'layout' (cards, bank accounts, national IDs): the same letters and
 *   digits with other separators, spacing or case; the real value comes back
 *   in that layout. For cards also a mention of the last four digits next to
 *   card words, when no other card stand-in ends in them.
 * - 'phone': the national significant number with any national or
 *   international prefix (or none) and any grouping; the real number comes
 *   back with the prefix and grouping the reply used.
 */
export type StandInVariants =
  | { readonly kind: 'layout'; readonly card: boolean }
  | {
      readonly kind: 'phone';
      readonly callingCode: string;
      /** National significant numbers, digits only, of equal length. */
      readonly standInNumber: string;
      readonly realNumber: string;
    };

/**
 * The mappings of the current conversation. `version` changes whenever the
 * mappings change, so callers can rebuild matchers only when needed.
 */
export interface StandInSource {
  readonly version: number;
  mappings(): readonly StandInMapping[];
  /**
   * Calls `listener` after every change (e.g. mappings loaded from the vault
   * or dropped), including changes no page update would reveal. Returns the
   * removal.
   */
  subscribe(listener: () => void): () => void;
}

/** A stand-in found in text, as [start, end) UTF-16 offsets. */
export interface Replacement {
  readonly start: number;
  readonly end: number;
  readonly standIn: string;
  readonly real: string;
}

export interface RestoreMatcher {
  /** Non-overlapping stand-ins in `text`, left to right. */
  find(text: string): Replacement[];
  /**
   * Occurrences of any stand-in, ignoring boundaries. Used by the leak check
   * to count stand-in text still visible, including fused forms.
   */
  countOccurrences(text: string): number;
}
