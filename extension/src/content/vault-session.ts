/**
 * The content script's view of the vault for one tab: which conversation the
 * tab shows, and that conversation's stand-in → real mappings, held in
 * memory only while the page shows it.
 *
 * - Conversation: `{site}:{id}` from the URL, or a pending ID of this tab's
 *   own for a new chat. When a new chat with masked values gets its ID, the
 *   pending chat is migrated to it.
 * - Masking runs the masker's prepare/commit exchange with the service
 *   worker (batched) as one operation for the current conversation; any
 *   failure rejects, so the send is blocked.
 * - Loading (page start, conversation change, another tab's send) asks for
 *   the stored mappings; the request safety net learns them before the
 *   restorer may show any real value.
 *
 * Vault operations run one at a time in the order they were asked for, so a
 * send always masks into the conversation its migration finished moving.
 */
import type { SiteAdapter } from '@/src/adapters/types.ts';
import type {
  CommittedValue,
  IssueVault,
  PreparedValue,
} from '@/src/core/masker.ts';
import type {
  BoundaryRule,
  StandInMapping,
  StandInSource,
} from '@/src/core/restore/index.ts';
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
    issue: (vault: IssueVault) => Promise<string[]>,
  ): Promise<string[]>;
  /** True for a stand-in of the current conversation. */
  isIssued(value: string): boolean;
  handleNotice(notice: VaultNotice): void;
  /** Forgets the real values (page hidden); `resume` loads them again. */
  clear(): void;
  resume(): void;
  state(): SessionState;
  /** Forgets everything and refuses further work. */
  dispose(): void;
}

function boundaryFor(type: EntityType): BoundaryRule {
  return type === 'EMAIL' ? 'email' : 'word';
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

  const byStandIn = new Map<string, StandInMapping>();
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

  const publish = (): void => {
    mappings = [...byStandIn.values()];
    beforePublish(mappings);
    version += 1;
    for (const listener of listeners) listener();
  };

  const add = (standIn: string, real: string, type: EntityType): boolean => {
    const key = standIn.toLowerCase();
    if (byStandIn.has(key)) return false;
    byStandIn.set(key, { standIn, real, boundary: boundaryFor(type) });
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
        return;
      }
      const reply = result.value;
      if (reply.status !== 'ok') {
        status = reply.status === 'keys-lost' ? 'keys-lost' : 'error';
        devlog('session.failed', { reason: failureReason(reply) });
        return;
      }
      let added = 0;
      for (const mapping of reply.mappings) {
        if (add(mapping.standIn, mapping.real, mapping.type)) added += 1;
      }
      failed = reply.failed;
      status = 'ready';
      devlog('session.loaded', { count: reply.mappings.length });
      if (added > 0) publish();
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
        return { dateOffsetDays, values };
      },
      commit: async (entries) => {
        const values: CommittedValue[] = [];
        for (const batch of batches(entries)) {
          const result = await messenger.send(
            'vault.commit',
            { conversationId: target.id, entries: batch },
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
          values.push(...result.value.items);
        }
        return values;
      },
    };
  };

  const mask = (
    items: readonly MaskItem[],
    issue: (vault: IssueVault) => Promise<string[]>,
  ): Promise<string[]> => {
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
      const standIns = await issue(vaultFor(target, masking));
      if (masking !== generation || isDisposed()) {
        return fail('prompt-changed');
      }
      if (standIns.length !== items.length) return fail('count-mismatch');
      let added = false;
      for (const [index, standIn] of standIns.entries()) {
        const item = items[index];
        if (item !== undefined && add(standIn, item.value, item.type)) {
          added = true;
        }
      }
      if (target.urlId === null && standIns.length > 0) pendingUsed = true;
      if (added) publish();
      return standIns;
    });
  };

  const handleNotice = (notice: VaultNotice): void => {
    if (disposed || conversation === null) return;
    const current = conversation;
    if (notice.name === 'vault.changed') {
      if (notice.conversationId === current.id) void load(current);
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
    isIssued: (value) => byStandIn.has(value.toLowerCase()),
    handleNotice,
    clear: () => {
      generation += 1;
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
      migration = null;
      forget();
      listeners.clear();
    },
  };
}
