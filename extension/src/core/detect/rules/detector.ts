/**
 * The rule detector: finds personal data in a prompt with the global rules
 * and the enabled country packs.
 *
 * 1. Normalise the text for matching (text.ts); spans map back exactly.
 * 2. Every enabled rule scans for candidates. Candidates overlapping an
 *    excluded span (stand-ins already issued) are dropped.
 * 3. Context: a candidate without a required context word is dropped; one
 *    with a negative context word (and no context word) is dropped.
 * 4. Each remaining candidate is validated.
 * 5. Same text, same type, several readings (e.g. two packs' 9-digit IDs):
 *    TR-R3 picks one, preferring (1) a reading with a context word nearby,
 *    (2) a home region, (3) the strongest validation. If more than one is
 *    left and none is checksum-validated, the result is "possible". The other
 *    readings become alternatives.
 * 6. Overlaps: candidates are taken greedily in this order, skipping any that
 *    overlaps one already taken (spans are half-open, so neighbours that touch
 *    are both kept):
 *    1. confirmed before possible;
 *    2. stronger validation (checksum > structural > none);
 *    3. with a context word before without;
 *    4. longer before shorter;
 *    5. type: SECRET, BANK, CARD, NATIONAL_ID, EMAIL, PHONE, then the rest;
 *    6. earlier start;
 *    7. rule order.
 *    Strength comes before context so that, for example, a "card" word near
 *    an IBAN cannot let a card-like digit run split the IBAN.
 *
 * Pure: no browser APIs. Long work (the first all-region phone check) yields
 * at the caller's checkpoint.
 */
import type { CountryCode } from '../../../shared/country.ts';
import {
  ENTITY_TYPES,
  type Detection,
  type DetectionAlternative,
  type EntityType,
} from '../../../shared/entities.ts';
import { blockingCheckpoint, type Checkpoint } from '../schedule.ts';
import { prepareText, type MatchText, type Span } from '../text.ts';
import { hasContextWord } from './context.ts';
import { GLOBAL_RULES } from './global.ts';
import type { CountryPack } from './packs/index.ts';
import type { Finding, Rule, Strength } from './types.ts';

export interface DetectOptions {
  /** Regions tried first for national phone numbers and preferred in ties. */
  readonly homeRegions: readonly CountryCode[];
  /** Entity types to detect; rules of other types do not run. */
  readonly entityTypes: ReadonlySet<EntityType>;
  /** Enabled country packs (see enabledPacks). */
  readonly packs: readonly CountryPack[];
  /** Spans of the original text that must not be detected (issued stand-ins). */
  readonly exclude: readonly Span[];
  /** Where long work may yield; blocking when omitted. */
  readonly checkpoint?: Checkpoint;
}

/** "possible" results never claim more than this. */
const POSSIBLE_CONFIDENCE = 0.5;

const STRENGTH_RANK: Record<Strength, number> = {
  checksum: 0,
  structural: 1,
  none: 2,
};

const TYPE_ORDER: readonly EntityType[] = [
  'SECRET',
  'BANK',
  'CARD',
  'NATIONAL_ID',
  'EMAIL',
  'PHONE',
];

function typeRank(type: EntityType): number {
  const index = TYPE_ORDER.indexOf(type);
  return index === -1 ? TYPE_ORDER.length + ENTITY_TYPES.indexOf(type) : index;
}

interface Candidate {
  rule: Rule;
  /** Order of the rule in the rule list (last tie-break). */
  ruleIndex: number;
  /** Span in the match text. */
  match: Span;
  /** Span in the original text. */
  span: Span;
  hasContext: boolean;
  finding: Finding;
}

interface Resolved {
  primary: Candidate;
  possible: boolean;
  alternatives: readonly DetectionAlternative[];
}

function overlaps(a: Span, b: Span): boolean {
  return a.start < b.end && b.start < a.end;
}

function confidenceOf(candidate: Candidate, possible: boolean): number {
  const { confidence } = candidate.rule;
  const value =
    candidate.finding.strength === 'checksum'
      ? confidence.validated
      : candidate.hasContext
        ? confidence.context
        : confidence.none;
  return possible ? Math.min(value, POSSIBLE_CONFIDENCE) : value;
}

function readingKey(candidate: Candidate): string {
  return `${candidate.finding.subtype ?? ''}|${candidate.finding.country ?? ''}`;
}

/** TR-R3 among candidates with the same span and type. */
function resolveReadings(
  group: readonly Candidate[],
  homeRegions: readonly CountryCode[],
): Resolved {
  let pool = [...group];
  const withContext = pool.filter((candidate) => candidate.hasContext);
  if (withContext.length > 0) pool = withContext;
  const home = pool.filter(
    (candidate) =>
      candidate.finding.country !== null &&
      homeRegions.includes(candidate.finding.country),
  );
  if (home.length > 0) pool = home;
  const best = Math.min(
    ...pool.map((candidate) => STRENGTH_RANK[candidate.finding.strength]),
  );
  pool = pool.filter(
    (candidate) => STRENGTH_RANK[candidate.finding.strength] === best,
  );
  pool.sort((a, b) => a.ruleIndex - b.ruleIndex);
  const [primary] = pool;
  if (primary === undefined) throw new Error('empty reading group');

  const primaryKey = readingKey(primary);
  const readings = new Set(pool.map(readingKey));
  const ambiguous = readings.size > 1;
  const possible =
    primary.finding.possible || (ambiguous && best !== STRENGTH_RANK.checksum);

  const seen = new Set([primaryKey]);
  const alternatives: DetectionAlternative[] = [];
  const others = [
    ...pool,
    ...group.filter((candidate) => !pool.includes(candidate)),
  ];
  for (const candidate of others) {
    const key = readingKey(candidate);
    if (seen.has(key)) continue;
    seen.add(key);
    alternatives.push({
      subtype: candidate.finding.subtype,
      country: candidate.finding.country,
      confidence: confidenceOf(candidate, true),
    });
  }
  for (const alternative of primary.finding.alternatives) {
    const key = `${alternative.subtype ?? ''}|${alternative.country ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    alternatives.push(alternative);
  }
  return { primary, possible, alternatives };
}

function compareForSelection(a: Resolved, b: Resolved): number {
  const pa = a.primary;
  const pb = b.primary;
  return (
    Number(a.possible) - Number(b.possible) ||
    STRENGTH_RANK[pa.finding.strength] - STRENGTH_RANK[pb.finding.strength] ||
    Number(pb.hasContext) - Number(pa.hasContext) ||
    pb.span.end - pb.span.start - (pa.span.end - pa.span.start) ||
    typeRank(pa.rule.type) - typeRank(pb.rule.type) ||
    pa.span.start - pb.span.start ||
    pa.ruleIndex - pb.ruleIndex
  );
}

/** Index of the first span in `sorted` (by start) that ends after `at`. */
function firstEndingAfter(sorted: readonly Span[], at: number): number {
  let low = 0;
  let high = sorted.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    const span = sorted[middle];
    if (span !== undefined && span.end <= at) low = middle + 1;
    else high = middle;
  }
  return low;
}

/** Greedy selection; `taken` stays sorted and non-overlapping. */
function selectNonOverlapping(resolved: Resolved[]): Resolved[] {
  resolved.sort(compareForSelection);
  const taken: Resolved[] = [];
  const spans: Span[] = [];
  for (const item of resolved) {
    const { span } = item.primary;
    // Taken spans do not overlap, so their ends are ordered like their starts.
    const index = firstEndingAfter(spans, span.start);
    const next = spans[index];
    if (next !== undefined && overlaps(next, span)) continue;
    spans.splice(index, 0, span);
    taken.splice(index, 0, item);
  }
  return taken;
}

function isExcluded(span: Span, exclude: readonly Span[]): boolean {
  return exclude.some((excluded) => overlaps(excluded, span));
}

async function collectCandidates(
  text: MatchText,
  rules: readonly Rule[],
  options: DetectOptions,
  checkpoint: Checkpoint,
): Promise<Candidate[]> {
  const candidates: Candidate[] = [];
  for (const [ruleIndex, rule] of rules.entries()) {
    // Collected first: validation may yield, and scanners keep state.
    const matches = [...rule.find(text.text)];
    for (const match of matches) {
      const pending = checkpoint();
      if (pending !== undefined) await pending;
      if (match.end <= match.start) continue;
      const span = text.toOriginal(match.start, match.end);
      if (isExcluded(span, options.exclude)) continue;
      const hasContext =
        rule.context !== null && hasContextWord(text.text, match, rule.context);
      if (rule.contextRequired && !hasContext) continue;
      if (
        !hasContext &&
        rule.negativeContext.some((negative) =>
          hasContextWord(text.text, match, negative),
        )
      ) {
        continue;
      }
      const verdict = await rule.validate(
        text.text.slice(match.start, match.end),
        { homeRegions: options.homeRegions, hasContext, checkpoint },
      );
      if (!verdict.valid) continue;
      candidates.push({
        rule,
        ruleIndex,
        match,
        span,
        hasContext,
        finding: verdict,
      });
    }
  }
  return candidates;
}

function groupReadings(candidates: readonly Candidate[]): Candidate[][] {
  const groups = new Map<string, Candidate[]>();
  for (const candidate of candidates) {
    const key = `${candidate.rule.type}:${candidate.span.start.toString()}:${candidate.span.end.toString()}`;
    const group = groups.get(key);
    if (group === undefined) groups.set(key, [candidate]);
    else group.push(candidate);
  }
  return [...groups.values()];
}

/** Rules that run for these options, in tie-break order. */
export function activeRules(options: DetectOptions): Rule[] {
  return [
    ...GLOBAL_RULES,
    ...options.packs.flatMap((pack) => pack.rules),
  ].filter((rule) => options.entityTypes.has(rule.type));
}

/**
 * Non-overlapping detections, sorted by position. Spans and values refer to
 * `original` exactly.
 */
export async function detectRules(
  original: string,
  options: DetectOptions,
): Promise<Detection[]> {
  const checkpoint = options.checkpoint ?? blockingCheckpoint();
  const text = prepareText(original);
  const candidates = await collectCandidates(
    text,
    activeRules(options),
    options,
    checkpoint,
  );
  const resolved = groupReadings(candidates).map((group) =>
    resolveReadings(group, options.homeRegions),
  );
  return selectNonOverlapping(resolved).map(
    ({ primary, possible, alternatives }) => ({
      type: primary.rule.type,
      subtype: primary.finding.subtype,
      country: primary.finding.country,
      start: primary.span.start,
      end: primary.span.end,
      value: original.slice(primary.span.start, primary.span.end),
      confidence: confidenceOf(primary, possible),
      validated: primary.finding.strength !== 'none',
      source: 'rule',
      status: possible ? 'possible' : 'confirmed',
      alternatives,
    }),
  );
}
