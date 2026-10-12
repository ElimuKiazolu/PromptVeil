import { AdapterError, type SiteAdapter } from '@/src/adapters/types.ts';
import { devlog, type DevReason } from '@/src/shared/devlog.ts';
import {
  INSTANCE_PING_EVENT,
  INSTANCE_READY_EVENT,
  SEND_EVENT_TYPES,
  isSendEvent,
} from './send-events.ts';

export type PromptTransform = (text: string) => string | Promise<string>;

export interface InterceptorOptions {
  adapter: SiteAdapter;
  transform: PromptTransform;
  /** Removes every listener when aborted (content script invalidated). */
  signal: AbortSignal;
  target?: Window;
}

class SendAbort extends Error {
  readonly reason: DevReason;

  constructor(reason: DevReason) {
    super(reason);
    this.name = 'SendAbort';
    this.reason = reason;
  }
}

function reasonOf(error: unknown): DevReason {
  if (error instanceof SendAbort) return error.reason;
  if (error instanceof AdapterError && error.code !== 'not-implemented') {
    return error.code;
  }
  return 'unexpected-error';
}

/**
 * Holds every user send, runs `transform` on the prompt, writes the result
 * back into the editor and then sends it through the site's own control.
 *
 * Fails closed: if any step throws, nothing is sent and the editor keeps the
 * user's original text.
 */
export function installInterceptor({
  adapter,
  transform,
  signal,
  target = window,
}: InterceptorOptions): void {
  let busy = false;
  // Set only while our own triggerSend runs, so that send passes through.
  let sendingOurselves = false;

  const send = (): void => {
    if (signal.aborted) throw new SendAbort('context-invalidated');
    sendingOurselves = true;
    try {
      adapter.triggerSend();
    } finally {
      sendingOurselves = false;
    }
  };

  const restore = async (original: string): Promise<void> => {
    try {
      if (adapter.readPrompt() !== original) {
        await adapter.writePrompt(original);
      }
    } catch (error) {
      devlog('send.blocked', 'restore-failed', error);
    }
  };

  const process = async (original: string): Promise<void> => {
    let edited = false;
    try {
      let masked: string;
      try {
        masked = await transform(original);
      } catch (error) {
        throw new SendAbort(
          error instanceof SendAbort ? error.reason : 'transform-failed',
        );
      }
      if (adapter.readPrompt() !== original) {
        throw new SendAbort('prompt-changed');
      }
      if (masked !== original) {
        edited = true;
        await adapter.writePrompt(masked);
      }
      send();
      devlog(edited ? 'send.masked' : 'send.passthrough');
    } catch (error) {
      devlog('send.blocked', reasonOf(error), error);
      if (edited) await restore(original);
    }
  };

  const onSendEvent = (event: Event): void => {
    if (sendingOurselves || !isSendEvent(adapter, event)) return;

    if (busy) {
      event.preventDefault();
      event.stopImmediatePropagation();
      devlog('send.ignored-busy');
      return;
    }

    let original: string;
    try {
      original = adapter.readPrompt();
    } catch (error) {
      event.preventDefault();
      event.stopImmediatePropagation();
      devlog('send.blocked', reasonOf(error), error);
      return;
    }
    // Nothing to protect; let the site handle it as usual.
    if (original.trim() === '') return;

    event.preventDefault();
    event.stopImmediatePropagation();
    devlog('send.intercepted');
    busy = true;
    void process(original).finally(() => {
      busy = false;
    });
  };

  for (const type of SEND_EVENT_TYPES) {
    target.addEventListener(type, onSendEvent, { capture: true, signal });
  }
  const announce = (): void => {
    target.dispatchEvent(new Event(INSTANCE_READY_EVENT));
  };
  target.addEventListener(INSTANCE_PING_EVENT, announce, { signal });
  signal.addEventListener('abort', () => {
    devlog('interceptor.removed', 'context-invalidated');
  });
  devlog('interceptor.installed');
  announce();
}
