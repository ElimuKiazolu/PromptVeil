import {
  NET_KEY_OFFER,
  NET_MAIN_HELLO,
  isHandshakeWindowOpen,
  isValidKey,
  netChannelEvent,
  parseAddition,
  type NetAddition,
  type NetReport,
} from '@/src/shared/net-protocol.ts';
import { originalFunction } from './wrappers.ts';

export interface MainChannel {
  /** Sends a report to the isolated side; dropped before the handshake. */
  report(report: NetReport): void;
}

export interface MainChannelHandlers {
  onKey(key: string): void;
  onAdd(addition: NetAddition): void;
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

  const onAdd = (event: Event): void => {
    if (!(event instanceof CustomEventCtor)) return;
    const addition = parseAddition(event.detail);
    if (addition) handlers.onAdd(addition);
  };

  const onOffer = (event: Event): void => {
    if (key !== null || !isHandshakeWindowOpen(doc)) return;
    if (!(event instanceof CustomEventCtor)) return;
    const offered: unknown = event.detail;
    if (!isValidKey(offered)) return;
    key = offered;
    removeListener.call(doc, NET_KEY_OFFER, onOffer);
    addListener.call(doc, netChannelEvent(offered, 'add'), onAdd);
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
  };
}
