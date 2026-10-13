/**
 * Development-only diagnostics.
 *
 * The signature only accepts fixed codes, so prompt text or detected values
 * can never be passed in. For errors, only the error's class name is printed,
 * never its message. Production builds compile every call away.
 */

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
  | 'restore.leak-check';

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
  | 'unexpected-error';

const PREFIX = '[PromptVeil]';

/** Distinguishes content-script instances (one per page load or injection). */
const INSTANCE_TAG = Math.random().toString(36).slice(2, 6);

export interface DevDetails {
  reason?: DevReason;
  /** Only the error's class name is printed. */
  error?: unknown;
  /** A count, e.g. of values restored or stand-ins left visible. */
  count?: number;
}

export function devlog(event: DevEvent, details: DevDetails = {}): void {
  if (!import.meta.env.DEV) return;
  const parts: string[] = [PREFIX, 'dev', INSTANCE_TAG, event];
  if (details.reason !== undefined) parts.push(details.reason);
  if (details.error !== undefined) parts.push(errorName(details.error));
  if (details.count !== undefined)
    parts.push(`count=${details.count.toString()}`);
  // Info level is visible with DevTools' default console levels.
  console.info(parts.join(' '));
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}
