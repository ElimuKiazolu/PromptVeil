/**
 * The send pipeline: replaces each confirmed detection in a prompt with its
 * stand-in (TR §3, outbound, rules only until the NER model and Review).
 *
 * detect (settings: types, packs, home regions) → confirmed items of the
 * masked types, each distinct value once → vault prepare → generate (sliced,
 * so no task runs long) → prompt checks → vault commit (a taken stand-in
 * moves that value to its next attempt) → rewrite. Any failure rejects, so
 * the send is blocked and the prompt stays as it was.
 *
 * "Possible" detections are not masked until the Review panel (P9); they are
 * counted in the report.
 *
 * TR-S3 checks made here (the vault checks stored stand-ins and stored real
 * values): a stand-in must not equal any value detected in the prompt (of
 * any type, compared by letters and digits, and by normal form for its own
 * type), must not appear in the rest of the prompt, and two new stand-ins
 * of one send must differ.
 */
import type { Detection, EntityType } from '../shared/entities.ts';
import type { MaskItem } from '../shared/vault-protocol.ts';
import type { Checkpoint } from './detect/schedule.ts';
import { isSpikeStandIn } from './spike-standin.ts';
import type { StandIn, StandInRequest } from './surrogate/types.ts';

/** Attempts per value before the send is blocked. */
export const MAX_STAND_IN_ATTEMPTS = 20;

/** Types with stand-in generators: the types masked live. */
export const MASKABLE_TYPES: ReadonlySet<EntityType> = new Set<EntityType>([
  'EMAIL',
  'PHONE',
  'CARD',
  'BANK',
  'SECRET',
  'NATIONAL_ID',
]);

export type PreparedValue =
  | { kind: 'existing'; standIn: string }
  | { kind: 'new'; seed: Uint8Array; number: number };

export interface CommitEntry {
  item: MaskItem;
  standIn: string;
  standInNormalised: string;
}

export type CommittedValue =
  { kind: 'inserted' | 'existing'; standIn: string } | { kind: 'taken' };

/** The current conversation's vault, for one masking. */
export interface IssueVault {
  prepare(
    items: readonly MaskItem[],
  ): Promise<{ dateOffsetDays: number; values: readonly PreparedValue[] }>;
  commit(entries: readonly CommitEntry[]): Promise<readonly CommittedValue[]>;
}

export type StandInFactory = (
  request: StandInRequest,
  seed: Uint8Array,
  attempt: number,
) => StandIn | null;

/** Thrown when a value has no free stand-in after MAX_STAND_IN_ATTEMPTS. */
export class StandInsExhaustedError extends Error {
  constructor() {
    super('exhausted');
    this.name = 'StandInsExhaustedError';
  }
}

/** Time spent per phase of one send, in ms. */
export interface PipelineTimings {
  rules: number;
  prepare: number;
  generate: number;
  commit: number;
  total: number;
}

export interface PipelineReport {
  timings: PipelineTimings;
  /** Distinct values masked. */
  masked: number;
  /** "Possible" detections of masked types, left as they are. */
  possible: number;
}

/**
 * True for a detection the pipeline masks: a confirmed value of a masked
 * type that is not already a stand-in (issued in this conversation, or the
 * email stand-in format of an earlier page load). The request safety net's
 * message check uses the same rule, so it blocks exactly what a send would
 * have masked.
 */
export function needsMasking(
  detection: Detection,
  types: ReadonlySet<EntityType>,
  isIssued: (value: string) => boolean,
): boolean {
  return (
    types.has(detection.type) &&
    detection.status === 'confirmed' &&
    !isIssued(detection.value) &&
    !isSpikeStandIn(detection.value)
  );
}

/** Letters and digits, lower case: how stand-ins are compared with text. */
function compact(value: string): string {
  return value.replace(/[^A-Za-z0-9]/gu, '').toLowerCase();
}

/** What the prompt holds besides the values masked (for TR-S3). */
export interface PromptView {
  /** Compact forms of every value detected in the prompt. */
  readonly detected: ReadonlySet<string>;
  /** Normal forms of the values to mask, by type. */
  readonly normalised: ReadonlySet<string>;
  /** The rest of the prompt (detected spans removed), compact. */
  readonly rest: string;
}

export function promptView(
  text: string,
  detections: readonly Detection[],
  items: readonly MaskItem[],
): PromptView {
  const spans = [...detections].sort((a, b) => a.start - b.start);
  let rest = '';
  let cursor = 0;
  for (const span of spans) {
    if (span.start < cursor) continue;
    // A separator that compact() drops would join the text around the
    // span; "|" never appears in a compact stand-in.
    rest += `${compact(text.slice(cursor, span.start))}|`;
    cursor = span.end;
  }
  rest += compact(text.slice(cursor));
  return {
    detected: new Set(detections.map((detection) => compact(detection.value))),
    normalised: new Set(
      items.map((item) => `${item.type}\u0000${item.normalised}`),
    ),
    rest,
  };
}

/** True when the stand-in is free as far as the prompt is concerned. */
export function fitsPrompt(
  view: PromptView,
  type: EntityType,
  standIn: StandIn,
): boolean {
  const form = compact(standIn.value);
  return (
    !view.detected.has(form) &&
    !view.normalised.has(`${type}\u0000${standIn.normalised}`) &&
    !view.rest.includes(form)
  );
}

interface Pending {
  index: number;
  item: MaskItem;
  seed: Uint8Array;
  number: number;
  attempt: number;
}

export interface IssueOptions {
  standIn: StandInFactory;
  fits: (item: MaskItem, standIn: StandIn) => boolean;
  now: number;
  /** Called between values, so long runs of generation yield (8 ms slices). */
  checkpoint?: Checkpoint;
  /** Monotonic ms clock for the timings. */
  clock?: () => number;
  /** Receives the time spent in each step (added up over rounds). */
  timings?: Pick<PipelineTimings, 'prepare' | 'generate' | 'commit'>;
}

/**
 * One stand-in per item, in order: stored ones as they are, new ones
 * generated, checked and committed, retrying taken ones with the next
 * attempt. Deterministic for a seed: the same collisions give the same
 * stand-ins.
 */
export async function issueStandIns(
  items: readonly MaskItem[],
  vault: IssueVault,
  options: IssueOptions,
): Promise<string[]> {
  const clock = options.clock ?? (() => 0);
  const timings = options.timings ?? { prepare: 0, generate: 0, commit: 0 };
  let started = clock();
  const prepared = await vault.prepare(items);
  timings.prepare += clock() - started;
  if (prepared.values.length !== items.length) {
    throw new RangeError('one prepared value per item expected');
  }
  const standIns: (string | undefined)[] = [];
  let pending: Pending[] = [];
  for (const [index, value] of prepared.values.entries()) {
    const item = items[index];
    if (item === undefined) throw new RangeError('missing item');
    if (value.kind === 'existing') standIns[index] = value.standIn;
    else pending.push({ ...value, index, item, attempt: 0 });
  }

  while (pending.length > 0) {
    const chosen = new Set(
      standIns.flatMap((standIn) =>
        standIn === undefined ? [] : [compact(standIn)],
      ),
    );
    const entries: CommitEntry[] = [];
    for (const entry of pending) {
      const waiting = options.checkpoint?.();
      if (waiting !== undefined) await waiting;
      started = clock();
      const request: StandInRequest = {
        ...entry.item,
        dateOffsetDays: prepared.dateOffsetDays,
        number: entry.number,
        now: options.now,
      };
      for (;;) {
        if (entry.attempt >= MAX_STAND_IN_ATTEMPTS) {
          throw new StandInsExhaustedError();
        }
        const standIn = options.standIn(request, entry.seed, entry.attempt);
        if (
          standIn !== null &&
          !chosen.has(compact(standIn.value)) &&
          options.fits(entry.item, standIn)
        ) {
          chosen.add(compact(standIn.value));
          entries.push({
            item: entry.item,
            standIn: standIn.value,
            standInNormalised: standIn.normalised,
          });
          break;
        }
        entry.attempt += 1;
      }
      timings.generate += clock() - started;
    }
    started = clock();
    const committed = await vault.commit(entries);
    timings.commit += clock() - started;
    if (committed.length !== entries.length) {
      throw new RangeError('one commit result per entry expected');
    }
    const next: Pending[] = [];
    for (const [position, result] of committed.entries()) {
      const entry = pending[position];
      if (entry === undefined) throw new RangeError('missing entry');
      if (result.kind === 'taken') {
        entry.attempt += 1;
        next.push(entry);
      } else {
        standIns[entry.index] = result.standIn;
      }
    }
    pending = next;
  }

  return standIns.map((standIn) => {
    if (standIn === undefined) throw new RangeError('missing stand-in');
    return standIn;
  });
}

export interface PipelineOptions {
  /** The rule detector run on a prompt (the detection module's analyzer). */
  detect: (text: string) => Promise<readonly Detection[]>;
  /** The vault normal form of a detection. */
  normalise: (detection: Detection) => string | Promise<string>;
  /**
   * The stand-in engine (the detection module's, so it waits for the module
   * to load; a load failure rejects and blocks the send).
   */
  engine: () => Promise<StandInFactory>;
  /**
   * Runs `issue` against the current conversation's vault and returns its
   * stand-ins (the vault session; it rejects if the conversation changed).
   */
  mask: (
    items: readonly MaskItem[],
    issue: (vault: IssueVault) => Promise<string[]>,
  ) => Promise<readonly string[]>;
  /** True for a stand-in already issued in the current conversation. */
  isIssued: (value: string) => boolean;
  /** The types masked now (settings, limited to MASKABLE_TYPES). */
  entityTypes: () => ReadonlySet<EntityType>;
  /** A fresh checkpoint per send, for slicing generation. */
  checkpoint?: () => Checkpoint;
  /** Monotonic ms clock (timings). */
  clock?: () => number;
  /** Wall-clock ms (birth-date shifts). */
  now?: () => number;
  /** Receives each masked send's report (counts and timings only). */
  report?: (report: PipelineReport) => void;
}

export interface Pipeline {
  /** Replaces each confirmed value of a masked type with its stand-in. */
  transform: (text: string) => Promise<string>;
}

/** Identifies one value for the vault: type, subtype and normal form. */
function itemKey(item: MaskItem): string {
  return JSON.stringify([item.type, item.subtype, item.normalised]);
}

export function createPipeline(options: PipelineOptions): Pipeline {
  const { detect, normalise, isIssued } = options;
  const clock = options.clock ?? (() => 0);
  const now = options.now ?? Date.now;

  const transform = async (text: string): Promise<string> => {
    const started = clock();
    const detections = await detect(text);
    const rules = clock() - started;
    // Read after detection, which waits for the settings to load.
    const types = options.entityTypes();
    const spans: { detection: Detection; key: string }[] = [];
    const items = new Map<string, MaskItem>();
    let possible = 0;
    for (const detection of detections) {
      if (types.has(detection.type) && detection.status === 'possible') {
        possible += 1;
      }
      if (!needsMasking(detection, types, isIssued)) continue;
      const item: MaskItem = {
        type: detection.type,
        subtype: detection.subtype,
        country: detection.country,
        value: detection.value,
        normalised: await normalise(detection),
      };
      const key = itemKey(item);
      // Each value goes to the vault once, however often it appears.
      if (!items.has(key)) items.set(key, item);
      spans.push({ detection, key });
    }
    const timings: PipelineTimings = {
      rules,
      prepare: 0,
      generate: 0,
      commit: 0,
      total: 0,
    };
    if (spans.length === 0) {
      timings.total = clock() - started;
      options.report?.({ timings, masked: 0, possible });
      return text;
    }

    const unique = [...items.entries()];
    const uniqueItems = unique.map(([, item]) => item);
    const view = promptView(text, detections, uniqueItems);
    const engine = await options.engine();
    const standIns = await options.mask(uniqueItems, (vault) =>
      issueStandIns(uniqueItems, vault, {
        standIn: engine,
        fits: (item, standIn) => fitsPrompt(view, item.type, standIn),
        now: now(),
        checkpoint: options.checkpoint?.(),
        clock,
        timings,
      }),
    );
    if (standIns.length !== unique.length) {
      throw new RangeError('one stand-in per item expected');
    }
    const byKey = new Map(
      unique.map(([key], index) => [key, standIns[index]] as const),
    );

    // One pass over the prompt, whatever the number of replacements.
    let out = '';
    let cursor = 0;
    for (const { detection, key } of spans) {
      const standIn = byKey.get(key);
      if (standIn === undefined) throw new RangeError('missing stand-in');
      out += text.slice(cursor, detection.start) + standIn;
      cursor = detection.end;
    }
    timings.total = clock() - started;
    options.report?.({ timings, masked: unique.length, possible });
    return out + text.slice(cursor);
  };

  return { transform };
}
