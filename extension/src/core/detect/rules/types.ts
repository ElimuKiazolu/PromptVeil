/**
 * The rule model shared by the global rules and the country packs.
 *
 * A rule finds candidate spans with a linear-time scanner, then checks each
 * candidate with its validator. Context words near a candidate can be
 * required, can lower a validator's thresholds, and break ties between
 * readings (TR-R3); negative context words veto a candidate.
 */
import type { CountryCode } from '../../../shared/country.ts';
import type {
  DetectionAlternative,
  EntitySubtype,
  EntityType,
} from '../../../shared/entities.ts';
import type { Checkpoint } from '../schedule.ts';
import type { Span } from '../text.ts';

/**
 * How strongly validation vouches for a value.
 * - checksum: a check digit or checksum, or a format random text cannot hit
 *   by chance (vendor key prefixes, PEM blocks, `Authorization: Basic`);
 * - structural: format rules only (phone metadata, entropy measures);
 * - none: shape or context only.
 */
export type Strength = 'checksum' | 'structural' | 'none';

export interface ContextWords {
  /**
   * Lower-case words or phrases, separated by single spaces. Underscores,
   * hyphens and camelCase in the text count as spaces ("api_key", "apiKey"
   * and "api key" all match "api key"). Latin words match whole words only;
   * other scripts match anywhere.
   */
  readonly words: readonly string[];
  /** Characters searched before the candidate. */
  readonly before: number;
  /** Characters searched after the candidate. */
  readonly after: number;
}

export interface Confidence {
  /** Validated by a checksum-strength check. */
  readonly validated: number;
  /** Structurally valid with a context word nearby. */
  readonly context: number;
  /** Anything else, including every "possible" result. */
  readonly none: number;
}

export interface RuleEnv {
  readonly homeRegions: readonly CountryCode[];
  /** True when one of the rule's context words is within its window. */
  readonly hasContext: boolean;
  /** For validators with long-running work (the all-region phone pass). */
  readonly checkpoint: Checkpoint;
}

export interface Finding {
  readonly valid: true;
  readonly strength: Strength;
  readonly subtype: EntitySubtype | null;
  readonly country: CountryCode | null;
  /** Never masked automatically; offered in the Review panel instead. */
  readonly possible: boolean;
  /** Other readings the validator itself found (e.g. phone regions). */
  readonly alternatives: readonly DetectionAlternative[];
}

export type Verdict = { readonly valid: false } | Finding;

export const INVALID: Verdict = { valid: false };

export interface Rule {
  /** Unique and stable, e.g. "global.card" or "gb.nino". */
  readonly id: string;
  readonly type: EntityType;
  readonly subtype: EntitySubtype | null;
  /** Country the format belongs to; null for global rules. */
  readonly country: CountryCode | null;
  /**
   * Candidate spans in the match text, in order. Must run in time linear in
   * the text length: bounded, non-nested quantifiers or a hand-written scan.
   */
  find(text: string): Iterable<Span>;
  /** Receives the candidate's text as normalised for matching. */
  validate(value: string, env: RuleEnv): Verdict | Promise<Verdict>;
  readonly context: ContextWords | null;
  /** Candidates without a context word are dropped. */
  readonly contextRequired: boolean;
  /**
   * Words that mark the candidate as something else (an order number, not a
   * phone number). They veto it unless a context word is also present.
   */
  readonly negativeContext: readonly ContextWords[];
  readonly confidence: Confidence;
}

/** A valid finding with the rule's own subtype and country. */
export function finding(
  rule: Pick<Rule, 'subtype' | 'country'>,
  strength: Strength,
  options: {
    possible?: boolean;
    country?: CountryCode | null;
    alternatives?: readonly DetectionAlternative[];
  } = {},
): Finding {
  return {
    valid: true,
    strength,
    subtype: rule.subtype,
    country: options.country === undefined ? rule.country : options.country,
    possible: options.possible ?? false,
    alternatives: options.alternatives ?? [],
  };
}
