/**
 * Typed runtime messaging between the extension's own contexts (content
 * scripts, background, offscreen document, extension pages).
 *
 * One protocol map names every message with its request and response types;
 * a spec gives each a runtime shape check, because messages cross context
 * boundaries as plain data. Senders get a typed result and never an
 * exception. Receivers ignore anything not sent by this extension or not in
 * the envelope format, and answer requests that fail their shape check with
 * a rejection.
 *
 * Not for the MAIN-world request net: that is a separate keyed DOM event
 * channel (src/net/channel.ts), because the page's world has no runtime API.
 *
 * Messages carry no real values except where a later phase needs prompt text
 * to cross contexts (content → offscreen NER). Logs only ever name the
 * failure, never a payload.
 */
import { devlog } from './devlog.ts';

/** A shape check for data that arrived from another context. */
export type Guard<T> = (value: unknown) => value is T;

/** The request and response types of one message. */
export interface MessageTypes {
  request: unknown;
  response: unknown;
}

/** Message name → request and response types (an interface or type alias). */
export type ProtocolShape<P> = { [K in keyof P]: MessageTypes };

/** Runtime shape checks for every message of a protocol. */
export type ProtocolSpec<P extends ProtocolShape<P>> = {
  readonly [K in keyof P]: {
    readonly request: Guard<P[K]['request']>;
    readonly response: Guard<P[K]['response']>;
  };
};

/**
 * The extension's messages. Entries are added as features need them; the
 * first are the pipeline and NER requests (P3, P7). Until then every name
 * maps to never, so nothing can be sent or handled.
 */
export type Protocol = Record<string, never>;

export const PROTOCOL: ProtocolSpec<Protocol> = {};

export type MessagingError =
  /** No reply within the timeout. */
  | 'timeout'
  /** The message reached no context that handles it. */
  | 'no-receiver'
  /** This script's extension context is gone (extension reloaded or updated). */
  | 'context-invalidated'
  /** The receiver refused the request (failed its shape check). */
  | 'rejected'
  /** The receiver's handler threw, or returned a malformed response. */
  | 'handler-failed'
  /** The reply failed the response shape check. */
  | 'invalid-response'
  /** The runtime refused to deliver the message (for example, not serialisable). */
  | 'send-failed';

export type SendResult<T> =
  { ok: true; value: T } | { ok: false; error: MessagingError };

/** The parts of a message sender this layer reads. */
export interface MessageSenderLike {
  id?: string;
  tab?: { id?: number };
  frameId?: number;
  url?: string;
}

export type RuntimeListener = (
  message: unknown,
  sender: MessageSenderLike,
  sendResponse: (response: unknown) => void,
) => boolean | undefined;

/** The runtime API this layer needs; `browser.runtime` satisfies it. */
export interface RuntimeLike {
  readonly id: string | undefined;
  sendMessage(message: unknown): Promise<unknown>;
  readonly onMessage: {
    addListener(listener: RuntimeListener): void;
    removeListener(listener: RuntimeListener): void;
  };
}

export type Handler<Req, Res> = (
  request: Req,
  sender: MessageSenderLike,
) => Res | Promise<Res>;

export interface SendOptions {
  /** Default DEFAULT_TIMEOUT_MS. */
  timeoutMs?: number;
}

export interface Messenger<P extends ProtocolShape<P>> {
  send<K extends keyof P & string>(
    name: K,
    request: P[K]['request'],
    options?: SendOptions,
  ): Promise<SendResult<P[K]['response']>>;
  /** Registers the handler for `name` in this context; returns its removal. */
  handle<K extends keyof P & string>(
    name: K,
    handler: Handler<P[K]['request'], P[K]['response']>,
  ): () => void;
}

export const DEFAULT_TIMEOUT_MS = 5000;

/** Marks this layer's envelopes among any other runtime messages. */
const CHANNEL = 'promptveil/1';

interface RequestEnvelope {
  channel: typeof CHANNEL;
  name: string;
  request: unknown;
}

type ReplyEnvelope =
  | { channel: typeof CHANNEL; ok: true; response: unknown }
  | {
      channel: typeof CHANNEL;
      ok: false;
      error: 'rejected' | 'handler-failed';
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isRequestEnvelope(value: unknown): value is RequestEnvelope {
  return (
    isRecord(value) &&
    value.channel === CHANNEL &&
    typeof value.name === 'string' &&
    'request' in value
  );
}

function isReplyEnvelope(value: unknown): value is ReplyEnvelope {
  if (!isRecord(value) || value.channel !== CHANNEL) return false;
  if (value.ok === true) return 'response' in value;
  return (
    value.ok === false &&
    (value.error === 'rejected' || value.error === 'handler-failed')
  );
}

export function createMessenger<P extends ProtocolShape<P>>(
  spec: ProtocolSpec<P>,
  runtime: RuntimeLike,
): Messenger<P> {
  // Untyped by name inside: each entry is checked by its own guard first.
  const handlers = new Map<string, Handler<unknown, unknown>>();

  const specFor = (name: string) =>
    Object.hasOwn(spec, name) ? spec[name as keyof P] : undefined;

  const listener: RuntimeListener = (message, sender, sendResponse) => {
    if (!isRequestEnvelope(message)) return undefined;
    // Another context may handle this name; stay silent so it can answer.
    const handler = handlers.get(message.name);
    const entry = specFor(message.name);
    if (handler === undefined || entry === undefined) return undefined;

    const runtimeId = runtime.id;
    if (runtimeId === undefined || sender.id !== runtimeId) {
      devlog('message.rejected', { reason: 'foreign-sender' });
      return undefined;
    }
    const reply = (envelope: ReplyEnvelope): void => {
      sendResponse(envelope);
    };
    if (!entry.request(message.request)) {
      devlog('message.rejected', { reason: 'invalid-shape' });
      reply({ channel: CHANNEL, ok: false, error: 'rejected' });
      return false;
    }
    Promise.resolve()
      .then(() => handler(message.request, sender))
      .then(
        (response) => {
          if (entry.response(response)) {
            reply({ channel: CHANNEL, ok: true, response });
          } else {
            devlog('message.failed', { reason: 'invalid-shape' });
            reply({ channel: CHANNEL, ok: false, error: 'handler-failed' });
          }
        },
        (error: unknown) => {
          devlog('message.failed', { reason: 'handler-failed', error });
          reply({ channel: CHANNEL, ok: false, error: 'handler-failed' });
        },
      );
    // Keeps the reply channel open for the asynchronous answer.
    return true;
  };

  const handle: Messenger<P>['handle'] = (name, handler) => {
    if (handlers.has(name)) {
      throw new Error(`a handler for "${name}" is already registered`);
    }
    if (handlers.size === 0) runtime.onMessage.addListener(listener);
    const stored = handler as Handler<unknown, unknown>;
    handlers.set(name, stored);
    return () => {
      if (handlers.get(name) !== stored) return;
      handlers.delete(name);
      if (handlers.size === 0) runtime.onMessage.removeListener(listener);
    };
  };

  const send: Messenger<P>['send'] = async (name, request, options = {}) => {
    const entry = specFor(name);
    if (entry === undefined) return { ok: false, error: 'no-receiver' };
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const envelope: RequestEnvelope = { channel: CHANNEL, name, request };

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => {
        resolve('timeout');
      }, timeoutMs);
    });
    const delivery = (async (): Promise<
      { reply: unknown } | { error: MessagingError }
    > => {
      try {
        return { reply: await runtime.sendMessage(envelope) };
      } catch (error) {
        // An orphaned script's runtime has no id; anything else is a
        // delivery failure, including "no receiving end" in Chromium.
        const code: 'context-invalidated' | 'send-failed' =
          runtime.id === undefined ? 'context-invalidated' : 'send-failed';
        devlog('message.failed', { reason: code, error });
        return { error: code };
      }
    })();

    try {
      const outcome = await Promise.race([delivery, timeout]);
      if (outcome === 'timeout') {
        devlog('message.failed', { reason: 'timeout' });
        return { ok: false, error: 'timeout' };
      }
      if ('error' in outcome) return { ok: false, error: outcome.error };
      const { reply } = outcome;
      // No context answered: every listener stayed silent.
      if (reply === undefined) return { ok: false, error: 'no-receiver' };
      if (!isReplyEnvelope(reply)) {
        devlog('message.failed', { reason: 'invalid-shape' });
        return { ok: false, error: 'invalid-response' };
      }
      if (!reply.ok) return { ok: false, error: reply.error };
      if (!entry.response(reply.response)) {
        devlog('message.failed', { reason: 'invalid-shape' });
        return { ok: false, error: 'invalid-response' };
      }
      return { ok: true, value: reply.response };
    } finally {
      clearTimeout(timer);
    }
  };

  return { send, handle };
}
