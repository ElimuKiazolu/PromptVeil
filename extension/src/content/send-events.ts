import type { Composer, SiteAdapter } from '@/src/adapters/types.ts';

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
 * The composer the event would make the site send from, or null when the
 * event is not a send. Cheap checks come first, so ordinary typing returns
 * after a key comparison.
 */
export function sendEventComposer(
  adapter: SiteAdapter,
  event: Event,
): Composer | null {
  if (event.type === 'keydown') {
    if (!(event instanceof KeyboardEvent) || !isSendKey(event)) return null;
    const composer = adapter.composerFor(event.target);
    return composer && isInside(composer.getEditor(), event.target)
      ? composer
      : null;
  }
  if (event.type === 'click') {
    const composer = adapter.composerFor(event.target);
    return composer && isInside(composer.getSendButton(), event.target)
      ? composer
      : null;
  }
  if (event.type === 'submit') {
    if (!(event.target instanceof HTMLFormElement)) return null;
    const composer = adapter.composerFor(event.target);
    return composer && isInside(event.target, composer.getEditor())
      ? composer
      : null;
  }
  return null;
}

export const SEND_EVENT_TYPES = ['keydown', 'click', 'submit'] as const;

/**
 * Dispatched on window when an instance starts. Older instances in the same
 * tab retire into the block-only guard. Page scripts can forge this event,
 * which is acceptable only because it can never reduce protection: the
 * worst outcome is that sends are blocked.
 */
export const INSTANCE_STARTED_EVENT = 'promptveil:instance-started';
