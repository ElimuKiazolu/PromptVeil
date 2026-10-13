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

/**
 * True when the event would make the site send the current prompt. Cheap
 * checks come first, so ordinary typing returns after a key comparison.
 */
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
 * Dispatched on window when an instance starts. Older instances in the same
 * tab retire into the block-only guard. Page scripts can forge this event,
 * which is acceptable only because it can never reduce protection: the
 * worst outcome is that sends are blocked.
 */
export const INSTANCE_STARTED_EVENT = 'promptveil:instance-started';
