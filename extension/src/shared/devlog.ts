/**
 * Development-only diagnostics.
 *
 * The signature only accepts fixed codes, so prompt text or detected values
 * can never be passed in. For errors, only the error's class name is printed,
 * never its message. Production builds compile every call away.
 */

import type {
  NetCategory,
  NetSkipReason,
  NetTransport,
  NetWriteCheck,
  NetWriteResult,
} from './net-protocol.ts';
import type { VaultFailureCode } from './vault-protocol.ts';
import type { NoticeSurface } from '../core/notice/text.ts';

export type DevEvent =
  | 'instance.starting'
  | 'instance.ready'
  | 'instance.orphaned'
  | 'instance.superseded'
  | 'send.intercepted'
  | 'send.passthrough'
  | 'send.masked'
  | 'send.blocked'
  | 'send.ignored-busy'
  | 'guard.installed'
  | 'guard.blocked'
  | 'restore.started'
  | 'restore.stopped'
  | 'restore.applied'
  | 'restore.leak-check'
  | 'restore.protected'
  | 'restore.unrestored'
  | 'net.ready'
  | 'net.missing'
  | 'net.blocked'
  | 'net.skipped-binary'
  | 'net.checked'
  | 'net.failed'
  | 'net.synced'
  | 'net.added'
  | 'net.verified'
  | 'net.write'
  | 'message.rejected'
  | 'message.failed'
  | 'prepass.failed'
  | 'detection.loaded'
  | 'detection.failed'
  | 'warmup.done'
  | 'warmup.failed'
  | 'vault.ready'
  | 'vault.keys-lost'
  | 'vault.failed'
  | 'vault.forbidden'
  | 'vault.masked'
  | 'vault.loaded'
  | 'vault.load-failed'
  | 'vault.migrated'
  | 'vault.cleaned'
  | 'vault.deleted-all'
  | 'notice.failed'
  | 'write-notice.shown'
  | 'write-notice.hidden'
  | 'write-notice.scanned'
  | 'write-notice.silent'
  | 'write-check.blocked'
  | 'session.conversation'
  | 'session.loaded'
  | 'session.failed'
  | 'session.migrated'
  | 'session.dropped'
  | 'pipeline.timing'
  | 'pipeline.possible'
  | 'pipeline.ambiguous-dates'
  | 'pipeline.card-fallback'
  | 'pipeline.next-reading'
  | 'settings.loaded'
  | 'settings.failed';

export type DevReason =
  | 'editor-missing'
  | 'send-button-missing'
  | 'send-button-disabled'
  | 'send-button-stop'
  | 'prompt-changed'
  | 'write-mismatch'
  | 'restore-failed'
  | 'transform-failed'
  | 'send-failed'
  | 'context-invalidated'
  | 'net-missing'
  | 'unexpected-error'
  | 'foreign-sender'
  | 'invalid-shape'
  | 'handler-failed'
  | 'timeout'
  | 'load-failed'
  | 'load-timeout'
  | 'invalid-module'
  | 'disposed'
  | 'no-receiver'
  | 'rejected'
  | 'invalid-response'
  | 'keys-lost'
  | 'vault-error'
  | 'count-mismatch'
  | 'no-mappings'
  | 'decrypt-failed'
  | 'no-match';

const PREFIX = '[PromptVeil]';

/** Distinguishes content-script instances (one per page load or injection). */
const INSTANCE_TAG = Math.random().toString(36).slice(2, 6);

/** Phases of a send whose time is logged (ms). */
export type TimingPhase =
  'rules' | 'prepare' | 'generate' | 'commit' | 'write' | 'total';

export interface DevDetails {
  reason?: DevReason;
  /** Only the error's class name is printed. */
  error?: unknown;
  /** A count, e.g. of values restored or stand-ins left visible. */
  count?: number;
  /** Request safety net: which check blocked, and what kind of request. */
  tier?: 1 | 2;
  category?: NetCategory;
  transport?: NetTransport;
  /** Kinds of values a full check blocked for (type or type/subtype). */
  kinds?: readonly string[];
  /** Which notice (write notices): card, message or write. */
  surface?: NoticeSurface;
  /** Why a request body was not read. */
  skip?: NetSkipReason;
  /**
   * A first-party write (net.write): method, path with IDs replaced, key
   * names, body kind, how it was checked and the outcome. Never values.
   */
  write?: {
    method: string;
    path: string;
    fields: readonly string[];
    body: string;
    checked: NetWriteCheck;
    result: NetWriteResult;
  };
  /** Vault failure code. */
  vault?: VaultFailureCode;
  /** A duration in ms (e.g. a message request's verification). */
  ms?: number;
  /** Whether a verified message request was blocked. */
  block?: boolean;
  /** Durations of a send's phases, in ms. */
  timings?: Readonly<Partial<Record<TimingPhase, number>>>;
}

const TIMING_PHASES: readonly TimingPhase[] = [
  'rules',
  'prepare',
  'generate',
  'commit',
  'write',
  'total',
];

const ms = (value: number): string => value.toFixed(1);

export function devlog(event: DevEvent, details: DevDetails = {}): void {
  if (!import.meta.env.DEV) return;
  const parts: string[] = [PREFIX, 'dev', INSTANCE_TAG, event];
  if (details.reason !== undefined) parts.push(details.reason);
  if (details.error !== undefined) parts.push(errorName(details.error));
  if (details.count !== undefined)
    parts.push(`count=${details.count.toString()}`);
  if (details.tier !== undefined) parts.push(`tier=${details.tier.toString()}`);
  if (details.category !== undefined) {
    parts.push(`category=${details.category}`);
  }
  if (details.transport !== undefined) {
    parts.push(`transport=${details.transport}`);
  }
  if (details.skip !== undefined) parts.push(`skip=${details.skip}`);
  if (details.surface !== undefined) parts.push(`surface=${details.surface}`);
  if (details.kinds !== undefined)
    parts.push(`kinds=${details.kinds.join(',')}`);
  if (details.write !== undefined) {
    const w = details.write;
    parts.push(
      `method=${w.method}`,
      `path=${w.path}`,
      `fields=${w.fields.join(',')}`,
      `body=${w.body}`,
      `checked=${w.checked}`,
      `result=${w.result}`,
    );
  }
  if (details.vault !== undefined) parts.push(`vault=${details.vault}`);
  if (details.ms !== undefined) parts.push(`ms=${ms(details.ms)}`);
  if (details.block !== undefined) parts.push(`block=${String(details.block)}`);
  if (details.timings !== undefined) {
    for (const phase of TIMING_PHASES) {
      const value = details.timings[phase];
      if (value !== undefined) parts.push(`${phase}=${ms(value)}`);
    }
  }
  // Info level is visible with DevTools' default console levels.
  console.info(parts.join(' '));
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}
