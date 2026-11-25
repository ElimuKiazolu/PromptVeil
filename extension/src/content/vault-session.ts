/**
 * The content script's view of the vault for one tab: which conversation the
 * tab shows, and that conversation's stand-in → real mappings, held in
 * memory only while the page shows it.
 *
 * - Conversation: `{site}:{id}` from the URL, or a pending ID of this tab's
 *   own for a new chat. When a new chat with masked values gets its ID, the
 *   pending chat is migrated to it.
 * - Masking runs the pipeline's prepare/commit exchange with the service
 *   worker (batched) as one operation for the current conversation; any
 *   failure rejects, so the send is blocked.
 * - While the user types, `peek` looks the draft's values up without
 *   writing anything; Send reuses those results (stored stand-ins and
 *   seeds) when they are still valid, so it needs only the commit.
 * - Loading (page start, conversation change, another tab's send) asks for
 *   the stored mappings; the request safety net learns them before the
 *   restorer may show any real value.
 * - A PERSON mapping also restores its single name parts ("Hughes" alone),
 *   paired by position with the real name's parts, when that stand-in part
 *   stands for one real part only in the conversation.
 *
 * Vault operations run one at a time in the order they were asked for, so a
 * send always masks into the conversation its migration finished moving.
 */
import type { LoadOutcome } from './unrestored-check.ts';
import {
  derivedNamePairs,
  emailNameParts,
} from '@/src/core/names/email-parts.ts';
import type { SiteAdapter } from '@/src/adapters/types.ts';
import { nameParts } from '@/src/core/names/parts.ts';
import {
  StaleStandInsError,
  type CommittedValue,
  type IssuedStandIn,
  type IssuedValue,
  type IssueVault,
  type PreparedValue,
} from '@/src/core/pipeline.ts';
import {
  createVariantFinder,
  variantsFor,
  type BoundaryRule,
  type StandInMapping,
  type StandInSource,
  type VariantFinder,
} from '@/src/core/restore/index.ts';
import { netForms } from '@/src/core/net/forms.ts';
import {
  activeConversationId,
  isSiteConversationId,
  pendingConversationId,
} from '@/src/shared/conversation-id.ts';
import { devlog, type DevReason } from '@/src/shared/devlog.ts';
import type { Messenger, Protocol } from '@/src/shared/messaging.ts';
import type { EntityType } from '@/src/shared/entities.ts';
import {
  MAX_MASK_ITEMS,
  MAX_VARIANTS,
  type MaskItem,
  type PreparedItem,
  type VaultFailure,
  type VaultNotice,
} from '@/src/shared/vault-protocol.ts';

/** Masking 200 values can take a few seconds on a slow machine. */
const MASK_TIMEOUT_MS = 15_000;
const LOAD_TIMEOUT_MS = 10_000;

export type SessionStatus =
  /** Nothing loaded (new chat, dropped, or not loaded yet). */
  | 'empty'
  | 'loading'
  | 'ready'
  /** The vault's keys are gone; its mappings cannot be read. */
  | 'keys-lost'
  /** The last load or migration failed. */
  | 'error';

export interface SessionState {
  status: SessionStatus;
  /** Stored mappings that could not be read in the last load. */
  failed: number;
}

/** Thrown when a vault request fails; carries a code only. */
export class VaultSessionError extends Error {
  readonly reason: DevReason;

  constructor(reason: DevReason) {
    super(reason);
    this.name = 'VaultSessionError';
    this.reason = reason;
  }
}

export interface VaultSessionOptions {
  adapter: Pick<SiteAdapter, 'id' | 'getConversationId'>;
  messenger: Pick<Messenger<Protocol>, 'send'>;
  /**
   * Receives every mapping before it becomes visible to the restorer (the
   * request safety net learns the real values first).
   */
  beforePublish: (mappings: readonly StandInMapping[]) => void;
  /** New pending IDs (crypto.randomUUID). */
  randomUUID: () => string;
  /** Told how each conversation load ended (diagnostics). */
  onLoaded?: (outcome: LoadOutcome) => void;
}

export interface VaultSession {
  /** The mappings of the current conversation, for the restorer. */
  readonly source: StandInSource;
  /** Re-reads the URL; a changed conversation is migrated or loaded. */
  checkConversation(): void;
  /**
   * Runs `issue` against the current conversation's vault and remembers the
   * stand-ins it returns (one per item, in order); rejects on any failure,
   * or when the conversation changes meanwhile.
   */
  mask(
    items: readonly MaskItem[],
    issue: (vault: IssueVault) => Promise<IssuedStandIn[]>,
  ): Promise<IssuedStandIn[]>;
  /**
   * Looks the items up in the current conversation without storing
   * anything, so a later mask can skip that step. Values already looked up
   * are not asked for again.
   */
  peek(items: readonly MaskItem[]): Promise<void>;
  /**
   * True for a stand-in of the current conversation (a date-of-birth
   * stand-in in any written format).
   */
  isIssued(value: string): boolean;
  /** The current conversation's values and stand-ins (memory only). */
  issued(): readonly IssuedValue[];
  handleNotice(notice: VaultNotice): void;
  /** Forgets the real values (page hidden); `resume` loads them again. */
  clear(): void;
  resume(): void;
  state(): SessionState;
  /** Forgets everything and refuses further work. */
  dispose(): void;
}

/** Legacy Bitcoin addresses: Base58, where the case is part of the value. */
const BASE58_ADDRESS = /^[13mn2][1-9A-HJ-NP-Za-km-z]{24,34}$/u;

function boundaryFor(type: EntityType, standIn: string): BoundaryRule {
  if (type === 'EMAIL') return 'email';
  return type === 'CRYPTO' && BASE58_ADDRESS.test(standIn) ? 'exact' : 'word';
}

/** A value of the conversation as the session holds it. */
interface Held extends IssuedValue {
  readonly mapping: StandInMapping;
  /**
   * PERSON: the stand-in's name parts; EMAIL: its local part's pieces (as
   * stored or as just issued).
   */
  readonly parts: readonly string[];
}

/**
 * Mappings for single name parts: each stand-in part (two letters or more)
 * that stands for exactly one real part across the conversation. PERSON
 * parts restore as written (boundary 'name'); names derived from an email
 * stand-in's local part also in lower case or capitalised ('derived').
 */
function partMappings(held: Iterable<Held>): StandInMapping[] {
  const reals = new Map<string, Map<string, string>>();
  const shown = new Map<string, string>();
  const fromPerson = new Set<string>();
  const note = (part: string, real: string, person: boolean): void => {
    const key = part.toLowerCase();
    const forms = reals.get(key) ?? new Map<string, string>();
    forms.set(real.toLowerCase(), real);
    reals.set(key, forms);
    if (person) {
      fromPerson.add(key);
      shown.set(key, part);
    } else if (!shown.has(key)) {
      shown.set(key, part);
    }
  };
  // Real name pieces of the conversation: a derived piece equal to one of
  // them could be a real name in the reply, so it is never restored.
  const realPieces = new Set<string>();
  for (const value of held) {
    const pieces =
      value.type === 'PERSON'
        ? nameParts(value.real)
        : value.type === 'EMAIL'
          ? emailNameParts(value.real)
          : [];
    for (const piece of pieces) {
      realPieces.add(piece.toLowerCase().replace(/\p{N}+/gu, ''));
    }
  }
  for (const value of held) {
    if (value.type === 'EMAIL') {
      for (const pair of derivedNamePairs(value.parts, value.real)) {
        if (realPieces.has(pair.standIn.toLowerCase())) continue;
        note(pair.standIn, pair.real, false);
      }
      continue;
    }
    if (value.type !== 'PERSON') continue;
    const realParts = nameParts(value.real);
    if (realParts.length !== value.parts.length || realParts.length < 2) {
      continue;
    }
    for (const [i, part] of value.parts.entries()) {
      const real = realParts[i];
      if (real === undefined || Array.from(part).length < 2) continue;
      note(part, real, true);
    }
  }
  const out: StandInMapping[] = [];
  for (const [key, forms] of reals) {
    const standIn = shown.get(key);
    const [real] = forms.values();
    if (forms.size !== 1 || standIn === undefined || real === undefined) {
      continue;
    }
    // The whole name (or address) is what the request safety net checks.
    out.push({
      standIn,
      real,
      boundary: fromPerson.has(key) ? 'name' : 'derived',
      netForms: [],
    });
  }
  return out;
}

function failureReason(failure: VaultFailure): DevReason {
  return failure.status === 'keys-lost' ? 'keys-lost' : 'vault-error';
}

/** Decodes a base64 seed from the vault. */
function seedBytes(seed: string): Uint8Array {
  const binary = atob(seed);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function preparedValue(item: PreparedItem): PreparedValue {
  return item.kind === 'existing'
    ? item
    : { kind: 'new', seed: seedBytes(item.seed), number: item.number };
}

/** Identifies one value: type, subtype and normal form. */
function itemKey(item: MaskItem): string {
  return JSON.stringify([item.type, item.subtype, item.normalised]);
}

/** Entries and reused values in requests of at most MAX_MASK_ITEMS. */
function commitBatches<E, R>(
  entries: readonly E[],
  reused: readonly R[],
): { entries: E[]; reused: R[] }[] {
  const out: { entries: E[]; reused: R[] }[] = [];
  const total = entries.length + reused.length;
  for (let start = 0; start < total; start += MAX_MASK_ITEMS) {
    const end = Math.min(total, start + MAX_MASK_ITEMS);
    out.push({
      entries: entries.slice(start, Math.min(end, entries.length)),
      reused: reused.slice(
        Math.max(0, start - entries.length),
        Math.max(0, end - entries.length),
      ),
    });
  }
  return out;
}

/**
 * Looked-up values of one conversation (stored stand-ins and seeds), valid
 * while the conversation and the vault's view of it stay the same.
 */
interface PreparedCache {
  conversationId: string;
  generation: number;
  /** Null until the conversation exists in the vault. */
  dateOffsetDays: number | null;
  values: Map<string, PreparedValue>;
}

function batches<T>(items: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let start = 0; start < items.length; start += MAX_MASK_ITEMS) {
    out.push(items.slice(start, start + MAX_MASK_ITEMS));
  }
  return out;
}

interface Conversation {
  id: string;
  /** The site's ID from the URL; null for this tab's pending chat. */
  urlId: string | null;
}

export function createVaultSession(options: VaultSessionOptions): VaultSession {
  const { adapter, messenger, beforePublish, randomUUID } = options;
  const site = adapter.id;

  const byStandIn = new Map<string, Held>();
  let mappings: readonly StandInMapping[] = [];
  let version = 0;
  const listeners = new Set<() => void>();

  let conversation: Conversation | null = null;
  /** True once this tab masked into its pending chat. */
  let pendingUsed = false;
  /** A migration that has not succeeded yet (retried before the next mask). */
  let migration: { from: string; to: string } | null = null;
  /** Bumped when the conversation changes, so stale results are dropped. */
  let generation = 0;
  let status: SessionStatus = 'empty';
  let failed = 0;
  let disposed = false;
  // Read through a function after an await: the flag changes in callbacks.
  const isDisposed = (): boolean => disposed;
  let queue: Promise<unknown> = Promise.resolve();
  /** Real values: memory only, dropped with the other session data. */
  let prepared: PreparedCache | null = null;

  const cacheFor = (target: Conversation): PreparedCache | null =>
    prepared !== null &&
    prepared.conversationId === target.id &&
    prepared.generation === generation
      ? prepared
      : null;

  /** The cache for `target`, started afresh if it is for something else. */
  const cacheOf = (
    target: Conversation,
    dateOffsetDays: number | null,
  ): PreparedCache => {
    const current = cacheFor(target);
    if (current !== null) {
      current.dateOffsetDays ??= dateOffsetDays;
      return current;
    }
    prepared = {
      conversationId: target.id,
      generation,
      dateOffsetDays,
      values: new Map(),
    };
    return prepared;
  };

  /** Runs vault operations one at a time, in order. */
  const serial = <T>(task: () => Promise<T>): Promise<T> => {
    const run = queue.then(task);
    // The next task waits for this one either way; its outcome belongs to
    // the caller of serial().
    queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  /** Date-of-birth stand-ins by date, rebuilt when the mappings change. */
  let dates: { version: number; finder: VariantFinder } | null = null;
  /** True for a date-of-birth stand-in written in another format. */
  const isIssuedDate = (value: string): boolean => {
    if (dates?.version !== version) {
      dates = {
        version,
        finder: createVariantFinder(
          mappings.filter((mapping) => mapping.variants?.kind === 'date'),
        ),
      };
    }
    return dates.finder
      .find(value)
      .some((match) => match.start === 0 && match.end === value.length);
  };

  const publish = (): void => {
    const whole = [...byStandIn.values()];
    const wholeKeys = new Set(byStandIn.keys());
    mappings = [
      ...whole.map((value) => value.mapping),
      // A part never shadows a whole stand-in written the same way.
      ...partMappings(whole).filter(
        (part) => !wholeKeys.has(part.standIn.toLowerCase()),
      ),
    ];
    beforePublish(mappings);
    version += 1;
    for (const listener of listeners) listener();
  };

  const add = (
    standIn: string,
    real: string,
    type: EntityType,
    normalised: string,
    parts: readonly string[],
  ): boolean => {
    const key = standIn.toLowerCase();
    if (byStandIn.has(key)) return false;
    byStandIn.set(key, {
      type,
      real,
      standIn,
      // Email mappings stored before P6.5 have no pieces: take the
      // stand-in's own (its local part is not secret).
      parts:
        type === 'EMAIL' && parts.length === 0
          ? emailNameParts(standIn)
          : parts,
      mapping: {
        standIn,
        real,
        boundary: boundaryFor(type, standIn),
        netForms: netForms(type, real, normalised),
        entity: type,
        variants: variantsFor(type, standIn, normalised, parts),
      },
    });
    return true;
  };

  const forget = (): void => {
    if (byStandIn.size === 0) return;
    byStandIn.clear();
    publish();
  };

  const fail = (reason: DevReason): never => {
    devlog('session.failed', { reason });
    throw new VaultSessionError(reason);
  };

  const urlConversation = (): string | null => {
    const id = adapter.getConversationId();
    return id !== null && isSiteConversationId(site, id) ? id : null;
  };

  const load = (target: Conversation): Promise<void> =>
    serial(async () => {
      const loading = generation;
      if (disposed || conversation !== target) return;
      status = 'loading';
      const result = await messenger.send(
        'vault.load',
        { conversationId: target.id },
        { timeoutMs: LOAD_TIMEOUT_MS },
      );
      if (loading !== generation || isDisposed()) return;
      if (!result.ok) {
        status = 'error';
        devlog('session.failed', { reason: result.error });
        options.onLoaded?.({ status: 'error', mappings: 0, failed: 0 });
        return;
      }
      const reply = result.value;
      if (reply.status !== 'ok') {
        status = reply.status === 'keys-lost' ? 'keys-lost' : 'error';
        devlog('session.failed', { reason: failureReason(reply) });
        options.onLoaded?.({ status, mappings: 0, failed: 0 });
        return;
      }
      let added = 0;
      for (const mapping of reply.mappings) {
        if (
          add(
            mapping.standIn,
            mapping.real,
            mapping.type,
            mapping.normalised,
            mapping.variants,
          )
        ) {
          added += 1;
        }
      }
      failed = reply.failed;
      status = 'ready';
      devlog('session.loaded', { count: reply.mappings.length });
      if (added > 0) publish();
      options.onLoaded?.({
        status: 'ready',
        mappings: reply.mappings.length,
        failed,
      });
    });

  /** Moves the pending chat; rejects when it could not be moved. */
  const migrate = async (): Promise<void> => {
    const pending = migration;
    if (pending === null) return;
    const result = await messenger.send('vault.migrate', pending, {
      timeoutMs: MASK_TIMEOUT_MS,
    });
    if (!result.ok) fail(result.error);
    else if (
      result.value.status !== 'migrated' &&
      result.value.status !== 'nothing'
    ) {
      status = result.value.status === 'keys-lost' ? 'keys-lost' : 'error';
      fail(failureReason(result.value));
    }
    if (migration === pending) migration = null;
    devlog('session.migrated');
  };

  const checkConversation = (): void => {
    if (disposed) return;
    const urlId = urlConversation();
    if (conversation !== null && conversation.urlId === urlId) return;
    const previous = conversation;
    generation += 1;
    failed = 0;
    status = 'empty';

    if (urlId === null) {
      // A new chat: a pending ID of this tab's own, never reused.
      conversation = {
        id: pendingConversationId(site, randomUUID()),
        urlId: null,
      };
      pendingUsed = false;
      migration = null;
      forget();
      devlog('session.conversation');
      return;
    }

    const next: Conversation = {
      id: activeConversationId(site, urlId),
      urlId,
    };
    conversation = next;
    devlog('session.conversation');
    if (previous !== null && previous.urlId === null && pendingUsed) {
      // The new chat received its ID: its stand-ins are this
      // conversation's now, so they stay in memory while they move.
      migration = { from: previous.id, to: next.id };
      pendingUsed = false;
      void serial(migrate).catch(() => {
        // Already logged; the next mask retries before it sends.
        if (migration !== null) status = 'error';
      });
    } else {
      migration = null;
      forget();
    }
    void load(next);
  };

  /**
   * The vault of one conversation for one masking: requests are batched, and
   * every reply is dropped (the masking fails) once the page has moved to
   * another conversation or the values were dropped.
   */
  const vaultFor = (target: Conversation, masking: number): IssueVault => {
    const current = (): void => {
      if (masking !== generation || isDisposed()) fail('prompt-changed');
    };
    return {
      prepare: async (items) => {
        // Looked up while the user typed: nothing to ask for.
        const cached = cacheFor(target);
        if (cached !== null && cached.dateOffsetDays !== null) {
          const hits = items.map((item) => cached.values.get(itemKey(item)));
          if (hits.every((hit) => hit !== undefined)) {
            return {
              dateOffsetDays: cached.dateOffsetDays,
              values: hits,
            };
          }
        }
        const values: PreparedValue[] = [];
        let dateOffsetDays = 0;
        for (const batch of batches(items)) {
          const result = await messenger.send(
            'vault.prepare',
            { conversationId: target.id, items: batch },
            { timeoutMs: MASK_TIMEOUT_MS },
          );
          current();
          if (!result.ok) return fail(result.error);
          if (result.value.status !== 'ok') {
            if (result.value.status === 'keys-lost') status = 'keys-lost';
            return fail(failureReason(result.value));
          }
          if (result.value.items.length !== batch.length) {
            return fail('count-mismatch');
          }
          dateOffsetDays = result.value.dateOffsetDays;
          values.push(...result.value.items.map(preparedValue));
        }
        const cache = cacheOf(target, dateOffsetDays);
        for (const [index, value] of values.entries()) {
          const item = items[index];
          if (item !== undefined) cache.values.set(itemKey(item), value);
        }
        return { dateOffsetDays, values };
      },
      commit: async (entries, reused) => {
        const values: CommittedValue[] = [];
        let missing = 0;
        for (const batch of commitBatches(entries, reused)) {
          const result = await messenger.send(
            'vault.commit',
            {
              conversationId: target.id,
              entries: batch.entries.map((entry) => ({
                ...entry,
                // Too many parts to store: the whole name still restores.
                variants:
                  entry.variants.length <= MAX_VARIANTS
                    ? [...entry.variants]
                    : [],
              })),
              reused: batch.reused,
            },
            { timeoutMs: MASK_TIMEOUT_MS },
          );
          current();
          if (!result.ok) return fail(result.error);
          if (result.value.status !== 'ok') {
            if (result.value.status === 'keys-lost') status = 'keys-lost';
            return fail(failureReason(result.value));
          }
          if (result.value.items.length !== batch.entries.length) {
            return fail('count-mismatch');
          }
          values.push(...result.value.items);
          missing += result.value.missing;
        }
        // Stored now: later sends reuse these stand-ins.
        const cache = cacheFor(target);
        for (const [index, value] of values.entries()) {
          const entry = entries[index];
          if (cache !== null && entry !== undefined && value.kind !== 'taken') {
            cache.values.set(itemKey(entry.item), {
              kind: 'existing',
              standIn: value.standIn,
              variants:
                value.kind === 'existing' ? value.variants : entry.variants,
            });
          }
        }
        return { values, missing };
      },
    };
  };

  const mask = (
    items: readonly MaskItem[],
    issue: (vault: IssueVault) => Promise<IssuedStandIn[]>,
  ): Promise<IssuedStandIn[]> => {
    // A Send right after a navigation must not mask into the old chat.
    checkConversation();
    const target = conversation;
    const masking = generation;
    return serial(async () => {
      if (disposed || target === null) return fail('disposed');
      // The page moved to another chat (or the values were dropped) before
      // or while masking: these stand-ins would belong to the old one.
      if (masking !== generation) return fail('prompt-changed');
      if (migration !== null && migration.to === target.id) await migrate();
      let standIns: IssuedStandIn[];
      try {
        standIns = await issue(vaultFor(target, masking));
      } catch (error) {
        if (!(error instanceof StaleStandInsError)) throw error;
        // Values looked up earlier were deleted since: look them up again.
        prepared = null;
        standIns = await issue(vaultFor(target, masking));
      }
      if (masking !== generation || isDisposed()) {
        return fail('prompt-changed');
      }
      if (standIns.length !== items.length) return fail('count-mismatch');
      let added = false;
      for (const [index, standIn] of standIns.entries()) {
        const item = items[index];
        if (
          item !== undefined &&
          add(
            standIn.value,
            item.value,
            item.type,
            item.normalised,
            item.type === 'PERSON'
              ? nameParts(standIn.value)
              : standIn.variants,
          )
        ) {
          added = true;
        }
      }
      if (target.urlId === null && standIns.length > 0) pendingUsed = true;
      if (added) publish();
      return standIns;
    });
  };

  const peek = (items: readonly MaskItem[]): Promise<void> => {
    checkConversation();
    const target = conversation;
    const peeking = generation;
    return serial(async () => {
      if (disposed || target === null || peeking !== generation) return;
      const known = cacheFor(target);
      const missing = items.filter(
        (item) => known?.values.has(itemKey(item)) !== true,
      );
      if (missing.length === 0) return;
      for (const batch of batches(missing)) {
        const result = await messenger.send(
          'vault.peek',
          { conversationId: target.id, items: batch },
          { timeoutMs: LOAD_TIMEOUT_MS },
        );
        if (peeking !== generation || isDisposed()) return;
        if (!result.ok) return fail(result.error);
        if (result.value.status !== 'ok') {
          return fail(failureReason(result.value));
        }
        if (result.value.items.length !== batch.length) {
          return fail('count-mismatch');
        }
        const cache = cacheOf(target, result.value.dateOffsetDays);
        for (const [index, item] of result.value.items.entries()) {
          const value = batch[index];
          if (value !== undefined) {
            cache.values.set(itemKey(value), preparedValue(item));
          }
        }
      }
    });
  };

  const handleNotice = (notice: VaultNotice): void => {
    if (disposed || conversation === null) return;
    const current = conversation;
    if (notice.name === 'vault.changed') {
      if (notice.conversationId === current.id) {
        // Another tab stored values: looked-up results may be out of date.
        prepared = null;
        void load(current);
      }
      return;
    }
    if (
      notice.conversationIds !== 'all' &&
      !notice.conversationIds.includes(current.id)
    ) {
      return;
    }
    // Deleted from the vault: forget the values here too.
    generation += 1;
    prepared = null;
    if (current.urlId === null) pendingUsed = false;
    migration = null;
    status = 'empty';
    failed = 0;
    forget();
    devlog('session.dropped');
  };

  const source: StandInSource = {
    get version() {
      return version;
    },
    mappings: () => mappings,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };

  return {
    source,
    checkConversation,
    mask,
    peek,
    isIssued: (value) =>
      byStandIn.has(value.toLowerCase()) || isIssuedDate(value),
    issued: () => [...byStandIn.values()],
    handleNotice,
    clear: () => {
      generation += 1;
      prepared = null;
      status = 'empty';
      forget();
    },
    resume: () => {
      const current = conversation;
      if (disposed || current === null) return;
      // A pending chat has stored mappings only once this tab masked into it.
      if (current.urlId !== null || pendingUsed) void load(current);
    },
    state: () => ({ status, failed }),
    dispose: () => {
      if (disposed) return;
      disposed = true;
      generation += 1;
      prepared = null;
      migration = null;
      forget();
      listeners.clear();
    },
  };
}
