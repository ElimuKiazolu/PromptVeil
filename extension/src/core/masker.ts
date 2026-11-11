/**
 * The masker: replaces each detected value in a prompt with its stand-in.
 *
 * Stand-ins come from the vault in two steps (see src/core/vault/mask.ts):
 * the vault returns each value's stored stand-in or its seed; new stand-ins
 * are generated here by the stand-in engine (from the detection module),
 * checked against the prompt (TR-S3), and committed; a stand-in the vault
 * reports as taken moves to the next attempt. Any failure rejects, so the
 * send is blocked.
 *
 * TR-S3 checks made here (the vault checks stored stand-ins and stored real
 * values): a stand-in must not equal any value detected in the prompt (of
 * any type, compared by letters and digits, and by normal form for its own
 * type), must not appear in the rest of the prompt, and two new stand-ins
 * of one send must differ.
 */
import type { Detection, EntityType } from '../shared/entities.ts';
import type { MaskItem } from '../shared/vault-protocol.ts';
import { isSpikeStandIn } from './spike-standin.ts';
import type { StandIn, StandInRequest } from './surrogate/types.ts';

/** Attempts per value before the send is blocked. */
export const MAX_STAND_IN_ATTEMPTS = 20;

/**
 * Types masked on live sites. Only EMAIL until P6 switches on the other
 * types that have stand-in generators (PHONE, CARD, IBAN, SECRET,
 * NATIONAL_ID).
 */
export const LIVE_ENTITY_TYPES: ReadonlySet<EntityType> = new Set(['EMAIL']);

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

/**
 * One stand-in per item, in order: stored ones as they are, new ones
 * generated, checked and committed, retrying taken ones with the next
 * attempt. Deterministic for a seed: the same collisions give the same
 * stand-ins.
 */
export async function issueStandIns(
  items: readonly MaskItem[],
  vault: IssueVault,
  options: {
    standIn: StandInFactory;
    fits: (item: MaskItem, standIn: StandIn) => boolean;
    now: number;
  },
): Promise<string[]> {
  const prepared = await vault.prepare(items);
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
    }
    const committed = await vault.commit(entries);
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

export interface MaskerOptions {
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
  /** Confirmed detections of these types are masked. */
  entityTypes: ReadonlySet<EntityType>;
  now?: () => number;
}

export interface Masker {
  /** Replaces each detected value with its stand-in. */
  transform: (text: string) => Promise<string>;
}

/** Identifies one value for the vault: type, subtype and normal form. */
function itemKey(item: MaskItem): string {
  return JSON.stringify([item.type, item.subtype, item.normalised]);
}

export function createMasker(options: MaskerOptions): Masker {
  const { detect, normalise, isIssued, entityTypes } = options;
  const now = options.now ?? Date.now;

  const transform = async (text: string): Promise<string> => {
    const detections = await detect(text);
    const spans: { detection: Detection; key: string }[] = [];
    const items = new Map<string, MaskItem>();
    for (const detection of detections) {
      if (
        !entityTypes.has(detection.type) ||
        detection.status !== 'confirmed'
      ) {
        continue;
      }
      // A stand-in (edited or regenerated message, or one from an earlier
      // page load) is left as it is rather than masked a second time.
      if (isIssued(detection.value) || isSpikeStandIn(detection.value)) {
        continue;
      }
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
    if (spans.length === 0) return text;

    const unique = [...items.entries()];
    const uniqueItems = unique.map(([, item]) => item);
    const view = promptView(text, detections, uniqueItems);
    const engine = await options.engine();
    const standIns = await options.mask(uniqueItems, (vault) =>
      issueStandIns(uniqueItems, vault, {
        standIn: engine,
        fits: (item, standIn) => fitsPrompt(view, item.type, standIn),
        now: now(),
      }),
    );
    if (standIns.length !== unique.length) {
      throw new RangeError('one stand-in per item expected');
    }
    const byKey = new Map(
      unique.map(([key], index) => [key, standIns[index]] as const),
    );

    let out = '';
    let cursor = 0;
    for (const { detection, key } of spans) {
      const standIn = byKey.get(key);
      if (standIn === undefined) throw new RangeError('missing stand-in');
      out += text.slice(cursor, detection.start) + standIn;
      cursor = detection.end;
    }
    return out + text.slice(cursor);
  };

  return { transform };
}
