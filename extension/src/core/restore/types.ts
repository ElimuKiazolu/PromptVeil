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
}

/**
 * The mappings of the current conversation. `version` changes whenever the
 * mappings change, so callers can rebuild matchers only when needed.
 */
export interface StandInSource {
  readonly version: number;
  mappings(): readonly StandInMapping[];
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
