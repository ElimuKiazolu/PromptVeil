import { compactForm, MIN_FORM_LENGTH } from '@/src/core/net/compact.ts';
import {
  createFormHasher,
  normaliseValue,
  randomHashKey,
} from '@/src/core/net/hash.ts';
import { createRollingHash, rollingBase } from '@/src/core/net/rolling.ts';
import type { StandInMapping } from '@/src/core/restore/index.ts';
import { devlog } from '@/src/shared/devlog.ts';
import {
  NET_KEY_OFFER,
  NET_MAIN_HELLO,
  isHandshakeWindowOpen,
  netChannelEvent,
  parseReport,
  parseVerifyRequest,
  type NetAddition,
} from '@/src/shared/net-protocol.ts';

/**
 * Decides whether message text may be sent: true blocks it (it holds a value
 * that should have been masked). A rejection blocks it too.
 */
export type MessageVerifier = (texts: readonly string[]) => Promise<boolean>;

export interface NetBridge {
  /** True once the MAIN-world net confirmed the handshake. */
  isReady(): boolean;
  /** Runs `callback` when the net is ready (at once if it already is). */
  onReady(callback: () => void): void;
  /**
   * Gives the net every mapping it has not seen yet: the keyed forms of the
   * real value and (emails) the stand-in. Synchronous, so the net knows a
   * value before any request could carry it.
   */
  sync(mappings: readonly StandInMapping[]): void;
  /**
   * Answers the net's verify requests for message text sent with fetch.
   * Until a verifier is set, every such request is blocked.
   */
  setVerifier(verifier: MessageVerifier): void;
}

function formsOf(mapping: StandInMapping): readonly string[] {
  if (mapping.netForms !== undefined) return mapping.netForms;
  const form = compactForm(mapping.real);
  return form.length >= MIN_FORM_LENGTH ? [form] : [];
}

/**
 * The isolated-world end of the channel to the request safety net. Must run
 * at document_start: the handshake only succeeds before the page has any
 * element a script could run from. If the net never confirms, `isReady`
 * stays false and sends stay blocked.
 */
export function startNetBridge(doc: Document = document): NetBridge {
  const key = randomHashKey((bytes) => crypto.getRandomValues(bytes));
  const hash = createFormHasher(key);
  const rolling = createRollingHash(rollingBase(key));
  let ready = false;
  let verifier: MessageVerifier | null = null;
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
      const addition: NetAddition = { forms: [], standIns: [] };
      for (const mapping of mappings) {
        if (synced.has(mapping.standIn)) continue;
        synced.add(mapping.standIn);
        for (const form of formsOf(mapping)) {
          addition.forms.push({
            length: form.length,
            roll: rolling.of(form),
            hash: hash(form),
          });
        }
        // Tier 1's email check lets the email stand-ins through.
        if (mapping.boundary === 'email') {
          addition.standIns.push(normaliseValue('email', mapping.standIn));
        }
      }
      if (addition.forms.length === 0 && addition.standIns.length === 0) {
        return;
      }
      doc.dispatchEvent(
        new CustomEvent(netChannelEvent(key, 'add'), {
          detail: JSON.stringify(addition),
        }),
      );
      devlog('net.synced', { count: addition.forms.length });
    },
    setVerifier(next) {
      verifier = next;
    },
  };

  const answer = (id: number, block: boolean): void => {
    doc.dispatchEvent(
      new CustomEvent(netChannelEvent(key, 'verdict'), {
        detail: JSON.stringify({ id, block }),
      }),
    );
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
  doc.addEventListener(netChannelEvent(key, 'verify'), (event) => {
    if (!(event instanceof CustomEvent)) return;
    const request = parseVerifyRequest(event.detail);
    if (!request) return;
    const current = verifier;
    if (current === null) {
      answer(request.id, true);
      return;
    }
    current(request.texts).then(
      (block) => {
        answer(request.id, block);
      },
      (error: unknown) => {
        devlog('net.failed', { error });
        answer(request.id, true);
      },
    );
  });
  doc.addEventListener(NET_MAIN_HELLO, onHello);
  offer();

  return bridge;
}
