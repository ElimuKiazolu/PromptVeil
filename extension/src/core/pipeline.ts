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
 * of one send must differ. A PERSON stand-in's name parts must also differ
 * from every real name part of the prompt and the conversation, from the
 * other stand-ins' parts, and from the words of the rest of the prompt, so
 * a single name part restores to one real name only.
 *
 * Linked values: an EMAIL whose local part spells a PERSON value of the
 * send or the conversation is built from that person's stand-in (persons
 * are issued first), and every address at one real domain gets the same
 * stand-in domain.
 *
 * Dates of birth: every writing of one date shares a mapping (the normal
 * form is the date), and each occurrence gets the stand-in date written
 * the way that occurrence is written (read in the stand-in's stored order).
 */
import type { Detection, EntityType } from '../shared/entities.ts';
import type { MaskItem } from '../shared/vault-protocol.ts';
import { calendarDay } from './dates/calendar.ts';
import {
  birthDateBounds,
  isDateOrder,
  parseDateWriting,
  readAs,
  readDate,
  writeAs,
} from './dates/writing.ts';
import type { Checkpoint } from './detect/schedule.ts';
import { isSpikeStandIn } from './spike-standin.ts';
import { emailDomain, emailMatchesPerson } from './names/email-links.ts';
import { nameParts } from './names/parts.ts';
import type {
  PersonLink,
  StandIn,
  StandInLinks,
  StandInRequest,
} from './surrogate/types.ts';

/** Attempts per value before the send is blocked. */
export const MAX_STAND_IN_ATTEMPTS = 20;

/** Types with stand-in generators: the types masked live. */
export const MASKABLE_TYPES: ReadonlySet<EntityType> = new Set<EntityType>([
  'DOB',
  'EMAIL',
  'PHONE',
  'CARD',
  'BANK',
  'SECRET',
  'NATIONAL_ID',
  'IP',
  'CRYPTO',
]);

export type PreparedValue =
  /** Stored: its stand-in and stand-in-side variants (a DOB's order). */
  | { kind: 'existing'; standIn: string; variants: readonly string[] }
  | { kind: 'new'; seed: Uint8Array; number: number };

export interface CommitEntry {
  item: MaskItem;
  standIn: string;
  standInNormalised: string;
  /** PERSON: the stand-in's name parts; DOB: its order (stored as variants). */
  variants: readonly string[];
  /** The word-list locale the stand-in came from. */
  locale: string | null;
  /** EMAIL: the stand-in of the PERSON it belongs to. */
  parent: string | null;
}

export type CommittedValue =
  | { kind: 'inserted'; standIn: string }
  | { kind: 'existing'; standIn: string; variants: readonly string[] }
  | { kind: 'taken' };

/** A value's stand-in as issued, with its stand-in-side variants. */
export interface IssuedStandIn {
  readonly value: string;
  readonly variants: readonly string[];
}

/** The current conversation's vault, for one masking. */
export interface IssueVault {
  prepare(
    items: readonly MaskItem[],
  ): Promise<{ dateOffsetDays: number; values: readonly PreparedValue[] }>;
  /**
   * Stores new stand-ins and counts the reuse of stored ones (every send
   * commits once, so the conversation is marked as used). `missing`: reused
   * values no longer stored.
   */
  commit(
    entries: readonly CommitEntry[],
    reused: readonly MaskItem[],
  ): Promise<{ values: readonly CommittedValue[]; missing: number }>;
}

/**
 * Thrown when values looked up earlier (e.g. while the user typed) have been
 * deleted from the vault since: the caller looks them up again.
 */
export class StaleStandInsError extends Error {
  constructor() {
    super('stale');
    this.name = 'StaleStandInsError';
  }
}

export type StandInFactory = (
  request: StandInRequest,
  seed: Uint8Array,
  attempt: number,
) => StandIn | null;

/** The parts of a request that decide which word lists it needs. */
export type WordRequest = Pick<
  StandInRequest,
  'type' | 'value' | 'country' | 'links'
>;

/** The stand-in engine of the detection module. */
export interface StandInEngine {
  /** Loads the word lists these requests need; rejects if one cannot load. */
  load(requests: readonly WordRequest[]): Promise<void>;
  standIn: StandInFactory;
}

/** A value already issued in the conversation (memory only). */
export interface IssuedValue {
  readonly type: EntityType;
  readonly real: string;
  readonly standIn: string;
}

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
  /**
   * Dates of birth masked whose numbers allowed two dates, read in the home
   * region's order.
   */
  ambiguousDates: number;
  /**
   * Card stand-ins borrowed from a related brand (the value's own brand and
   * length used up in the conversation).
   */
  cardFallbacks: number;
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
  /** The rest's words, lower case. */
  readonly words: ReadonlySet<string>;
  /**
   * Name parts a PERSON stand-in must not use (lower case): the real names'
   * of the prompt and the conversation, and the conversation's stand-ins'.
   * Parts chosen during the send are added.
   */
  readonly nameParts: Set<string>;
}

const WORDS = /[\p{L}\p{M}]+/gu;

export function promptView(
  text: string,
  detections: readonly Detection[],
  items: readonly MaskItem[],
  issued: readonly IssuedValue[] = [],
): PromptView {
  const spans = [...detections].sort((a, b) => a.start - b.start);
  let rest = '';
  const words = new Set<string>();
  const addWords = (part: string): void => {
    for (const word of part.match(WORDS) ?? []) words.add(word.toLowerCase());
  };
  let cursor = 0;
  for (const span of spans) {
    if (span.start < cursor) continue;
    // A separator that compact() drops would join the text around the
    // span; "|" never appears in a compact stand-in.
    rest += `${compact(text.slice(cursor, span.start))}|`;
    addWords(text.slice(cursor, span.start));
    cursor = span.end;
  }
  rest += compact(text.slice(cursor));
  addWords(text.slice(cursor));
  const parts = new Set<string>();
  const addParts = (name: string): void => {
    for (const part of nameParts(name)) parts.add(part.toLowerCase());
  };
  for (const item of items) if (item.type === 'PERSON') addParts(item.value);
  for (const value of issued) {
    if (value.type !== 'PERSON') continue;
    addParts(value.real);
    addParts(value.standIn);
  }
  return {
    words,
    nameParts: parts,
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
    !view.rest.includes(form) &&
    standIn.parts.every((part) => {
      const lower = part.toLowerCase();
      return !view.nameParts.has(lower) && !view.words.has(lower);
    })
  );
}

interface Pending {
  index: number;
  item: MaskItem;
  seed: Uint8Array;
  number: number;
  attempt: number;
}

/** How the values of one send relate to each other. */
export interface IssueRelations {
  /** Items of a higher stage are issued after every lower stage's. */
  stageOf(item: MaskItem): number;
  /** The values this item's stand-in must agree with. */
  linksOf(item: MaskItem): StandInLinks | undefined;
  /** A stand-in was picked for the item (it may still be taken). */
  chosen(item: MaskItem, standIn: StandIn): void;
  /** The item's stand-in is final (stored now or before). */
  issued(item: MaskItem, standIn: string): void;
}

const NO_RELATIONS: IssueRelations = {
  stageOf: () => 0,
  linksOf: () => undefined,
  chosen: () => undefined,
  issued: () => undefined,
};

export interface IssueOptions {
  standIn: StandInFactory;
  /** Loads the word lists the requests need, before they are generated. */
  load?: (requests: readonly StandInRequest[]) => Promise<void>;
  relations?: IssueRelations;
  fits: (item: MaskItem, standIn: StandIn) => boolean;
  now: number;
  /** Called between values, so long runs of generation yield (8 ms slices). */
  checkpoint?: Checkpoint;
  /** Monotonic ms clock for the timings. */
  clock?: () => number;
  /** Receives the time spent in each step (added up over rounds). */
  timings?: Pick<PipelineTimings, 'prepare' | 'generate' | 'commit'>;
  /** Counts stand-ins committed that were borrowed (card fallbacks). */
  counts?: { fallbacks: number };
}

/**
 * One stand-in per item, in order: stored ones as they are, new ones
 * generated, checked and committed, retrying taken ones with the next
 * attempt, stage by stage (see IssueRelations). Deterministic for a seed:
 * the same collisions give the same stand-ins.
 */
export async function issueStandIns(
  items: readonly MaskItem[],
  vault: IssueVault,
  options: IssueOptions,
): Promise<IssuedStandIn[]> {
  const clock = options.clock ?? (() => 0);
  const timings = options.timings ?? { prepare: 0, generate: 0, commit: 0 };
  const relations = options.relations ?? NO_RELATIONS;
  let started = clock();
  const prepared = await vault.prepare(items);
  timings.prepare += clock() - started;
  if (prepared.values.length !== items.length) {
    throw new RangeError('one prepared value per item expected');
  }
  const standIns: (IssuedStandIn | undefined)[] = [];
  const stages = new Map<number, Pending[]>();
  let reused: MaskItem[] = [];
  for (const [index, value] of prepared.values.entries()) {
    const item = items[index];
    if (item === undefined) throw new RangeError('missing item');
    if (value.kind === 'existing') {
      standIns[index] = { value: value.standIn, variants: value.variants };
      reused.push(item);
      relations.issued(item, value.standIn);
    } else {
      const stage = relations.stageOf(item);
      stages.set(stage, [
        ...(stages.get(stage) ?? []),
        { ...value, index, item, attempt: 0 },
      ]);
    }
  }

  const requestOf = (entry: Pending): StandInRequest => {
    const links = relations.linksOf(entry.item);
    return {
      ...entry.item,
      dateOffsetDays: prepared.dateOffsetDays,
      number: entry.number,
      now: options.now,
      ...(links === undefined ? {} : { links }),
    };
  };

  // The first round runs even without new values: it counts the reuse.
  let first = true;
  const order = [...stages.keys()].sort((a, b) => a - b);
  if (order.length === 0) order.push(0);
  for (const stage of order) {
    let pending = stages.get(stage) ?? [];
    while (pending.length > 0 || first) {
      const chosen = new Set(
        standIns.flatMap((standIn) =>
          standIn === undefined ? [] : [compact(standIn.value)],
        ),
      );
      if (pending.length > 0) await options.load?.(pending.map(requestOf));
      const entries: CommitEntry[] = [];
      /** Per entry: a card number borrowed from a related brand. */
      const borrowed: boolean[] = [];
      for (const entry of pending) {
        const waiting = options.checkpoint?.();
        if (waiting !== undefined) await waiting;
        started = clock();
        // Built now: a stand-in domain chosen earlier in this round applies.
        const request = requestOf(entry);
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
            relations.chosen(entry.item, standIn);
            borrowed.push(standIn.fallback === true);
            entries.push({
              item: entry.item,
              standIn: standIn.value,
              standInNormalised: standIn.normalised,
              variants: standIn.parts,
              locale: standIn.locale,
              parent: request.links?.person?.standIn ?? null,
            });
            break;
          }
          entry.attempt += 1;
        }
        timings.generate += clock() - started;
      }
      started = clock();
      const { values: committed, missing } = await vault.commit(
        entries,
        reused,
      );
      timings.commit += clock() - started;
      if (missing > 0) throw new StaleStandInsError();
      first = false;
      reused = [];
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
          if (result.kind === 'inserted' && borrowed[position] === true) {
            if (options.counts !== undefined) options.counts.fallbacks += 1;
          }
          standIns[entry.index] = {
            value: result.standIn,
            variants:
              result.kind === 'existing'
                ? result.variants
                : (entries[position]?.variants ?? []),
          };
          relations.issued(entry.item, result.standIn);
        }
      }
      pending = next;
    }
  }

  return standIns.map((standIn) => {
    if (standIn === undefined) throw new RangeError('missing stand-in');
    return standIn;
  });
}

/**
 * Links between the values of one send and the conversation's: emails to
 * persons (issued first), real email domains to stand-in domains, and the
 * name parts chosen so far (TR-S3).
 */
export function issueRelations(
  items: readonly MaskItem[],
  issued: readonly IssuedValue[],
  view: PromptView,
): IssueRelations {
  const persons: PersonLink[] = issued
    .filter((value) => value.type === 'PERSON')
    .map((value) => ({ real: value.real, standIn: value.standIn }));
  const domains = new Map<string, string>();
  for (const value of issued) {
    if (value.type === 'EMAIL') {
      domains.set(emailDomain(value.real), emailDomain(value.standIn));
    }
  }
  const sendPersons = items.filter((item) => item.type === 'PERSON');
  return {
    stageOf: (item) =>
      item.type === 'EMAIL' &&
      sendPersons.some((person) => emailMatchesPerson(item.value, person.value))
        ? 1
        : 0,
    linksOf: (item) => {
      if (item.type !== 'EMAIL') return undefined;
      const person = persons.find((link) =>
        emailMatchesPerson(item.value, link.real),
      );
      const domain = domains.get(emailDomain(item.value));
      if (person === undefined && domain === undefined) return undefined;
      return {
        ...(person === undefined ? {} : { person }),
        ...(domain === undefined ? {} : { domain }),
      };
    },
    chosen: (item, standIn) => {
      if (item.type === 'EMAIL') {
        const real = emailDomain(item.value);
        if (!domains.has(real)) domains.set(real, emailDomain(standIn.value));
      }
      if (item.type !== 'PERSON') return;
      for (const part of standIn.parts) view.nameParts.add(part.toLowerCase());
    },
    issued: (item, standIn) => {
      // This send's persons come first: an address names the person
      // written next to it before one from earlier in the chat.
      if (item.type === 'PERSON')
        persons.unshift({ real: item.value, standIn });
    },
  };
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
  engine: () => Promise<StandInEngine>;
  /**
   * Runs `issue` against the current conversation's vault and returns its
   * stand-ins (the vault session; it rejects if the conversation changed).
   */
  mask: (
    items: readonly MaskItem[],
    issue: (vault: IssueVault) => Promise<IssuedStandIn[]>,
  ) => Promise<readonly IssuedStandIn[]>;
  /** True for a stand-in already issued in the current conversation. */
  isIssued: (value: string) => boolean;
  /** The current conversation's issued values (links, TR-S3 name parts). */
  issued?: () => readonly IssuedValue[];
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
  /**
   * Looks values up in the vault without storing anything (the session's
   * peek), so a Send of the same draft needs only the commit.
   */
  peek?: (items: readonly MaskItem[]) => Promise<void>;
}

export interface Pipeline {
  /** Replaces each confirmed value of a masked type with its stand-in. */
  transform: (text: string) => Promise<string>;
  /**
   * The work a Send of this draft would do before storing anything: detect
   * (cached by the analyzer) and look the values up (peek).
   */
  prepare: (text: string) => Promise<void>;
}

/** Identifies one value for the vault: type, subtype and normal form. */
function itemKey(item: MaskItem): string {
  return JSON.stringify([item.type, item.subtype, item.normalised]);
}

/**
 * The text that replaces one occurrence: the stand-in, and for a date of
 * birth the stand-in date written the way this occurrence is written (the
 * stand-in as issued when either cannot be read).
 */
function replacementFor(
  detection: Detection,
  standIn: IssuedStandIn,
  now: number,
): string {
  if (detection.type !== 'DOB') return standIn.value;
  const today = calendarDay(now);
  const [order] = standIn.variants;
  const writing = parseDateWriting(standIn.value);
  const date =
    isDateOrder(order) && writing !== null
      ? readAs(writing, order, today)
      : null;
  const here = readDate(
    detection.value,
    detection.country,
    today,
    birthDateBounds(today),
  );
  if (date === null || here === null) return standIn.value;
  return writeAs(here.writing, here.order, date) ?? standIn.value;
}

/** A date of birth whose numbers allowed two dates. */
function isAmbiguousDate(detection: Detection, now: number): boolean {
  if (detection.type !== 'DOB') return false;
  const today = calendarDay(now);
  return (
    readDate(detection.value, detection.country, today, birthDateBounds(today))
      ?.ambiguous === true
  );
}

export function createPipeline(options: PipelineOptions): Pipeline {
  const { detect, normalise, isIssued } = options;
  const clock = options.clock ?? (() => 0);
  const now = options.now ?? Date.now;

  /** The values a Send of these detections masks, each once. */
  const collect = async (detections: readonly Detection[]) => {
    // Read after detection, which waits for the settings to load.
    const types = options.entityTypes();
    const spans: { detection: Detection; key: string }[] = [];
    const items = new Map<string, MaskItem>();
    let possible = 0;
    let ambiguousDates = 0;
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
      if (isAmbiguousDate(detection, now())) ambiguousDates += 1;
      // Each value goes to the vault once, however often it appears.
      if (!items.has(key)) items.set(key, item);
      spans.push({ detection, key });
    }
    return { spans, items, possible, ambiguousDates };
  };

  const prepare = async (text: string): Promise<void> => {
    const { items } = await collect(await detect(text));
    if (items.size === 0) return;
    const values = [...items.values()];
    // The word lists a Send of this draft needs, loaded ahead.
    await (await options.engine()).load(values);
    await options.peek?.(values);
  };

  const transform = async (text: string): Promise<string> => {
    const started = clock();
    const detections = await detect(text);
    const rules = clock() - started;
    const { spans, items, possible, ambiguousDates } =
      await collect(detections);
    const timings: PipelineTimings = {
      rules,
      prepare: 0,
      generate: 0,
      commit: 0,
      total: 0,
    };
    if (spans.length === 0) {
      timings.total = clock() - started;
      options.report?.({
        timings,
        masked: 0,
        possible,
        ambiguousDates,
        cardFallbacks: 0,
      });
      return text;
    }

    const unique = [...items.entries()];
    const uniqueItems = unique.map(([, item]) => item);
    const issued = options.issued?.() ?? [];
    const view = promptView(text, detections, uniqueItems, issued);
    const engine = await options.engine();
    const masked = now();
    const counts = { fallbacks: 0 };
    const standIns = await options.mask(uniqueItems, (vault) =>
      issueStandIns(uniqueItems, vault, {
        standIn: engine.standIn,
        load: (requests) => engine.load(requests),
        relations: issueRelations(uniqueItems, issued, view),
        // A stand-in this conversation already uses is skipped here, so it
        // costs no commit round trip (the vault checks it again).
        fits: (item, standIn) =>
          !isIssued(standIn.value) && fitsPrompt(view, item.type, standIn),
        now: masked,
        checkpoint: options.checkpoint?.(),
        clock,
        timings,
        counts,
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
      out +=
        text.slice(cursor, detection.start) +
        replacementFor(detection, standIn, masked);
      cursor = detection.end;
    }
    timings.total = clock() - started;
    options.report?.({
      timings,
      masked: unique.length,
      possible,
      ambiguousDates,
      cardFallbacks: counts.fallbacks,
    });
    return out + text.slice(cursor);
  };

  return { transform, prepare };
}
