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
  | 'guard.blocked';

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

export function devlog(
  event: DevEvent,
  reason?: DevReason,
  error?: unknown,
): void {
  if (!import.meta.env.DEV) return;
  const parts: string[] = [PREFIX, 'dev', INSTANCE_TAG, event];
  if (reason !== undefined) parts.push(reason);
  if (error !== undefined) parts.push(errorName(error));
  // Info level is visible with DevTools' default console levels.
  console.info(parts.join(' '));
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}
