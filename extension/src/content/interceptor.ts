import {
  AdapterError,
  type Composer,
  type SiteAdapter,
} from '@/src/adapters/types.ts';
import { devlog, type DevReason } from '@/src/shared/devlog.ts';
import { SEND_EVENT_TYPES, sendEventComposer } from './send-events.ts';

export type PromptTransform = (text: string) => string | Promise<string>;

export interface InterceptorOptions {
  adapter: SiteAdapter;
  transform: PromptTransform;
  /** Removes every listener when aborted. */
  signal: AbortSignal;
  /** False once the extension context is gone; checked before every send. */
  isContextValid: () => boolean;
  /** Called when a send finds the extension context gone. */
  onOrphaned: () => void;
  /** False until the request safety net is confirmed; sends are blocked. */
  isNetReady: () => boolean;
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
  if (error instanceof AdapterError) return error.code;
  return 'unexpected-error';
}

function block(event: Event): void {
  event.preventDefault();
  event.stopImmediatePropagation();
}

/**
 * Holds every user send from any composer (the main one or an edit box),
 * runs `transform` on its prompt, writes the result back into that same
 * editor and then sends it through that composer's own control.
 *
 * The event handler itself only runs synchronous checks, snapshots the prompt
 * and blocks the event; the transform, write and send run in a later task.
 *
 * Fails closed: if any step throws, or the request safety net is not
 * confirmed, nothing is sent and the editor keeps the user's original text. Once a send has gone through, the editor is never
 * touched again, so text the site keeps queued stays masked.
 */
export function installInterceptor({
  adapter,
  transform,
  signal,
  isContextValid,
  onOrphaned,
  isNetReady,
  target = window,
}: InterceptorOptions): void {
  let busy = false;
  // Set only while our own triggerSend runs, so that send passes through.
  let sendingOurselves = false;

  const send = (composer: Composer): void => {
    if (signal.aborted) throw new SendAbort('context-invalidated');
    if (!isContextValid()) {
      onOrphaned();
      throw new SendAbort('context-invalidated');
    }
    sendingOurselves = true;
    try {
      composer.triggerSend();
    } finally {
      sendingOurselves = false;
    }
  };

  const restore = async (
    composer: Composer,
    original: string,
  ): Promise<void> => {
    try {
      if (composer.readPrompt() !== original) {
        await composer.writePrompt(original);
      }
    } catch (error) {
      devlog('send.blocked', { reason: 'restore-failed', error });
    }
  };

  const process = async (
    composer: Composer,
    original: string,
  ): Promise<void> => {
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
      if (composer.readPrompt() !== original) {
        throw new SendAbort('prompt-changed');
      }
      if (masked !== original) {
        edited = true;
        await composer.writePrompt(masked);
      }
      send(composer);
      devlog(edited ? 'send.masked' : 'send.passthrough');
    } catch (error) {
      devlog('send.blocked', { reason: reasonOf(error), error });
      if (edited) await restore(composer, original);
    }
  };

  const onSendEvent = (event: Event): void => {
    if (sendingOurselves) return;
    // The send belongs to exactly one composer (main or an edit box).
    const composer = sendEventComposer(adapter, event);
    if (!composer) return;

    if (busy) {
      block(event);
      devlog('send.ignored-busy');
      return;
    }

    if (!isContextValid()) {
      block(event);
      devlog('send.blocked', { reason: 'context-invalidated' });
      onOrphaned();
      return;
    }

    if (!isNetReady()) {
      block(event);
      devlog('send.blocked', { reason: 'net-missing' });
      return;
    }

    let original: string;
    try {
      original = composer.readPrompt();
    } catch (error) {
      block(event);
      devlog('send.blocked', { reason: reasonOf(error), error });
      return;
    }
    // Nothing to protect; let the site handle it as usual.
    if (original.trim() === '') return;

    block(event);
    devlog('send.intercepted');
    busy = true;
    setTimeout(() => {
      void process(composer, original).finally(() => {
        busy = false;
      });
    }, 0);
  };

  for (const type of SEND_EVENT_TYPES) {
    target.addEventListener(type, onSendEvent, { capture: true, signal });
  }
}
