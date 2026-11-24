import {
  NET_KEY_OFFER,
  NET_MAIN_HELLO,
  isHandshakeWindowOpen,
  isValidKey,
  netChannelEvent,
  parseAddition,
  parseVerdict,
  type NetAddition,
  type NetCategory,
  type NetReport,
} from '@/src/shared/net-protocol.ts';
import { originalFunction } from './wrappers.ts';

/** The isolated side's answer on the user's text of a write. */
export interface VerifyOutcome {
  readonly block: boolean;
  /** "possible" values found (logged only). */
  readonly possible: number;
}

const NO_ANSWER: VerifyOutcome = { block: true, possible: 0 };

export interface MainChannel {
  /** Sends a report to the isolated side; dropped before the handshake. */
  report(report: NetReport): void;
  /**
   * Asks the isolated side whether the user's text may be sent. Blocks
   * without an answer within `timeoutMs`, or before the handshake.
   */
  verify(
    texts: readonly string[],
    category: NetCategory,
    timeoutMs: number,
  ): Promise<VerifyOutcome>;
}

export interface MainChannelHandlers {
  onKey(key: string): void;
  onAdd(addition: NetAddition): void;
  /** Captured before page scripts run, so the page cannot stop a timeout. */
  setTimer(handler: () => void, ms: number): void;
}

/**
 * The MAIN-world end of the channel. DOM functions are captured when this
 * runs (at document_start, before any page script), so later changes the
 * page makes to EventTarget or CustomEvent cannot intercept it.
 *
 * Only one key is ever accepted, and only during the handshake window.
 * Additions can only grow the block lists; there is no way to remove an
 * entry or switch the net off.
 */
export function startMainChannel(
  doc: Document,
  handlers: MainChannelHandlers,
): MainChannel {
  const proto = EventTarget.prototype;
  const addListener = originalFunction(proto, 'addEventListener');
  const removeListener = originalFunction(proto, 'removeEventListener');
  const dispatch = originalFunction(proto, 'dispatchEvent');
  const CustomEventCtor = CustomEvent;

  let key: string | null = null;
  let nextId = 0;
  const pending = new Map<number, (outcome: VerifyOutcome) => void>();

  const onAdd = (event: Event): void => {
    if (!(event instanceof CustomEventCtor)) return;
    const addition = parseAddition(event.detail);
    if (addition) handlers.onAdd(addition);
  };

  const onVerdict = (event: Event): void => {
    if (!(event instanceof CustomEventCtor)) return;
    const verdict = parseVerdict(event.detail);
    if (!verdict) return;
    const settle = pending.get(verdict.id);
    pending.delete(verdict.id);
    settle?.({ block: verdict.block, possible: verdict.possible });
  };

  const onOffer = (event: Event): void => {
    if (key !== null || !isHandshakeWindowOpen(doc)) return;
    if (!(event instanceof CustomEventCtor)) return;
    const offered: unknown = event.detail;
    if (!isValidKey(offered)) return;
    key = offered;
    removeListener.call(doc, NET_KEY_OFFER, onOffer);
    addListener.call(doc, netChannelEvent(offered, 'add'), onAdd);
    addListener.call(doc, netChannelEvent(offered, 'verdict'), onVerdict);
    handlers.onKey(offered);
    dispatch.call(doc, new CustomEventCtor(netChannelEvent(offered, 'ready')));
  };

  addListener.call(doc, NET_KEY_OFFER, onOffer);
  // Lets an isolated side that started earlier send its key now.
  if (isHandshakeWindowOpen(doc)) {
    dispatch.call(doc, new CustomEventCtor(NET_MAIN_HELLO));
  }

  return {
    report(report) {
      if (key === null) return;
      dispatch.call(
        doc,
        new CustomEventCtor(netChannelEvent(key, 'report'), {
          detail: JSON.stringify(report),
        }),
      );
    },
    verify(texts, category, timeoutMs) {
      if (key === null) return Promise.resolve(NO_ANSWER);
      const id = nextId;
      nextId += 1;
      const answer = new Promise<VerifyOutcome>((resolve) => {
        pending.set(id, resolve);
        handlers.setTimer(() => {
          if (pending.delete(id)) resolve(NO_ANSWER);
        }, timeoutMs);
      });
      dispatch.call(
        doc,
        new CustomEventCtor(netChannelEvent(key, 'verify'), {
          detail: JSON.stringify({ id, texts, category }),
        }),
      );
      return answer;
    },
  };
}
