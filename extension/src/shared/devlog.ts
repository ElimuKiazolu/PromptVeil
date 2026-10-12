/**
 * Development-only diagnostics.
 *
 * The signature only accepts fixed codes, so prompt text or detected values
 * can never be passed in. For errors, only the error's class name is printed,
 * never its message.
 */

export type DevEvent =
  | 'interceptor.installed'
  | 'interceptor.removed'
  | 'send.intercepted'
  | 'send.passthrough'
  | 'send.masked'
  | 'send.blocked'
  | 'send.ignored-busy'
  | 'guard.installed'
  | 'guard.blocked'
  | 'guard.removed';

export type DevReason =
  | 'editor-missing'
  | 'send-button-missing'
  | 'send-button-disabled'
  | 'prompt-changed'
  | 'write-mismatch'
  | 'restore-failed'
  | 'transform-failed'
  | 'send-failed'
  | 'context-invalidated'
  | 'unexpected-error';

const PREFIX = '[PromptVeil]';

export function devlog(
  event: DevEvent,
  reason?: DevReason,
  error?: unknown,
): void {
  if (!import.meta.env.DEV) return;
  const parts: string[] = [PREFIX, event];
  if (reason !== undefined) parts.push(reason);
  if (error !== undefined) parts.push(errorName(error));
  console.debug(parts.join(' '));
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}
