import {
  createValueHasher,
  normaliseValue,
  randomHashKey,
} from '@/src/core/net/hash.ts';
import type { StandInMapping } from '@/src/core/restore/index.ts';
import { devlog } from '@/src/shared/devlog.ts';
import {
  NET_KEY_OFFER,
  NET_MAIN_HELLO,
  isHandshakeWindowOpen,
  netChannelEvent,
  parseReport,
  type NetAddition,
} from '@/src/shared/net-protocol.ts';

export interface NetBridge {
  /** True once the MAIN-world net confirmed the handshake. */
  isReady(): boolean;
  /** Runs `callback` when the net is ready (at once if it already is). */
  onReady(callback: () => void): void;
  /**
   * Gives the net every mapping it has not seen yet: a keyed hash of the real
   * value and the stand-in. Synchronous, so the net knows a value before any
   * request could carry it.
   */
  sync(mappings: readonly StandInMapping[]): void;
}

/**
 * The isolated-world end of the channel to the request safety net. Must run
 * at document_start: the handshake only succeeds before the page has any
 * element a script could run from. If the net never confirms, `isReady`
 * stays false and sends stay blocked.
 */
export function startNetBridge(doc: Document = document): NetBridge {
  const key = randomHashKey((bytes) => crypto.getRandomValues(bytes));
  const hash = createValueHasher(key);
  let ready = false;
  const waiting: (() => void)[] = [];
  const synced = new Set<string>();

  const bridge: NetBridge = {
    isReady: () => ready,
    onReady(callback) {
      if (ready) callback();
      else waiting.push(callback);
    },
    sync(mappings) {
      if (!ready) return;
      const addition: NetAddition = { hashes: [], standIns: [] };
      for (const mapping of mappings) {
        if (synced.has(mapping.standIn)) continue;
        synced.add(mapping.standIn);
        // Only emails are recognised by the net so far; other kinds follow
        // with the stand-in engine.
        if (mapping.boundary !== 'email') continue;
        addition.hashes.push(hash('email', mapping.real));
        addition.standIns.push(normaliseValue('email', mapping.standIn));
      }
      if (addition.hashes.length === 0) return;
      doc.dispatchEvent(
        new CustomEvent(netChannelEvent(key, 'add'), {
          detail: JSON.stringify(addition),
        }),
      );
      devlog('net.synced', { count: addition.hashes.length });
    },
  };

  if (!isHandshakeWindowOpen(doc)) {
    devlog('net.missing');
    return bridge;
  }

  const offer = (): void => {
    doc.dispatchEvent(new CustomEvent(NET_KEY_OFFER, { detail: key }));
  };
  // A MAIN side that starts after us announces itself; answer only within
  // the handshake window, so a page script can never make us send the key.
  const onHello = (): void => {
    if (!ready && isHandshakeWindowOpen(doc)) offer();
  };

  doc.addEventListener(
    netChannelEvent(key, 'ready'),
    () => {
      ready = true;
      doc.removeEventListener(NET_MAIN_HELLO, onHello);
      devlog('net.ready');
      for (const callback of waiting.splice(0)) callback();
    },
    { once: true },
  );
  doc.addEventListener(netChannelEvent(key, 'report'), (event) => {
    if (!(event instanceof CustomEvent)) return;
    const report = parseReport(event.detail);
    if (!report) return;
    const { event: name, ...details } = report;
    devlog(name, details);
  });
  doc.addEventListener(NET_MAIN_HELLO, onHello);
  offer();

  return bridge;
}
