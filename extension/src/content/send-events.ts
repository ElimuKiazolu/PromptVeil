import type { SiteAdapter } from '@/src/adapters/types.ts';

/**
 * Enter without Shift sends; Ctrl/Cmd+Enter is treated as a send too.
 * Enter during IME composition only confirms the composition; Chromium
 * reports that keydown with isComposing set.
 */
export function isSendKey(event: KeyboardEvent): boolean {
  return event.key === 'Enter' && !event.shiftKey && !event.isComposing;
}

function isInside(container: HTMLElement | null, target: EventTarget | null) {
  return (
    container !== null && target instanceof Node && container.contains(target)
  );
}

/** True when the event would make the site send the current prompt. */
export function isSendEvent(adapter: SiteAdapter, event: Event): boolean {
  if (event.type === 'keydown') {
    return (
      event instanceof KeyboardEvent &&
      isSendKey(event) &&
      isInside(adapter.getEditor(), event.target)
    );
  }
  if (event.type === 'click') {
    return isInside(adapter.getSendButton(), event.target);
  }
  if (event.type === 'submit') {
    const editor = adapter.getEditor();
    return (
      event.target instanceof HTMLFormElement &&
      editor !== null &&
      event.target.contains(editor)
    );
  }
  return false;
}

export const SEND_EVENT_TYPES = ['keydown', 'click', 'submit'] as const;

/**
 * Coordination between instances in the same tab. A live interceptor
 * announces itself with READY when installed and in answer to PING, so a
 * guard left behind by an invalidated instance can stand down.
 */
export const INSTANCE_READY_EVENT = 'promptveil:interceptor-ready';
export const INSTANCE_PING_EVENT = 'promptveil:interceptor-ping';
