import { compactForm, MIN_FORM_LENGTH } from '@/src/core/net/compact.ts';
import {
  createFormHasher,
  normaliseValue,
  randomHashKey,
} from '@/src/core/net/hash.ts';
import { createRollingHash, rollingBase } from '@/src/core/net/rolling.ts';
import type { NoticeItem } from '@/src/core/notice/text.ts';
import type { StandInMapping } from '@/src/core/restore/index.ts';
import type { EntityType } from '@/src/shared/entities.ts';
import { devlog, type DevDetails } from '@/src/shared/devlog.ts';
import {
  NET_KEY_OFFER,
  NET_MAIN_HELLO,
  isHandshakeWindowOpen,
  netChannelEvent,
  parseReport,
  parseVerifyRequest,
  type NetAddition,
  type NetCategory,
  type NetReport,
} from '@/src/shared/net-protocol.ts';

/** The isolated side's verdict on the user's text in a first-party write. */
export interface VerifierResult {
  /** The text holds a value that should have been masked. */
  readonly block: boolean;
  /** "possible" values found (counted, never blocked). */
  readonly possible: number;
  /** What blocks it, by kind (for the notice). */
  readonly items: readonly NoticeItem[];
  /**
   * Keyed hashes of the compact forms of the values that block it (the
   * channel key), so a notice can tell whether the user typed them.
   */
  readonly hashes: readonly string[];
}

/**
 * Decides whether the user's text in a first-party write may be sent. A
 * rejection blocks it.
 */
export type MessageVerifier = (
  texts: readonly string[],
  category: NetCategory,
) => Promise<VerifierResult>;

/**
 * The outcome of a verify request, for notices: the verifier's result, or
 * null when it failed (the write was blocked unchecked).
 */
/** Who a keyed form belongs to (no real value). */
export interface FormOwner {
  readonly type: EntityType;
  readonly standIn: string;
}

export type VerdictListener = (
  category: NetCategory,
  result: VerifierResult | null,
) => void;

/** A report from the net as dev-log details (fixed codes only). */
function reportDetails(report: NetReport): DevDetails {
  switch (report.event) {
    case 'net.added':
      return { count: report.count };
    case 'net.verified':
      return { ms: report.ms, block: report.block };
    case 'net.blocked':
      return {
        tier: report.tier,
        category: report.category,
        transport: report.transport,
      };
    case 'net.skipped-binary':
      return {
        category: report.category,
        transport: report.transport,
        skip: report.reason,
      };
    case 'net.write':
      return {
        category: report.category,
        transport: report.transport,
        write: {
          method: report.method,
          path: report.path,
          fields: report.fields,
          body: report.body,
          checked: report.checked,
          result: report.result,
        },
      };
    case 'net.checked':
    case 'net.failed':
      return { category: report.category, transport: report.transport };
  }
}

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
   * Answers the net's verify requests for the user's text in first-party
   * writes sent with fetch. Until a verifier is set, every such request is
   * blocked.
   */
  setVerifier(verifier: MessageVerifier): void;
  /** Every verify outcome (after the net was answered). */
  onVerdict(listener: VerdictListener): void;
  /** Every report from the net, parsed (production reports included). */
  onReport(listener: (report: NetReport) => void): void;
  /**
   * The masked value a keyed form hash belongs to: its type and its
   * stand-in (which tells values apart; a value can have several forms).
   */
  valueOfForm(hash: string): FormOwner | null;
  /** The keyed hash of a compact form, as the net computes it. */
  hashForm(form: string): string;
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
  const ownerByHash = new Map<string, FormOwner>();
  const verdictListeners: VerdictListener[] = [];
  const reportListeners: ((report: NetReport) => void)[] = [];

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
          const formHash = hash(form);
          if (mapping.entity !== undefined) {
            ownerByHash.set(formHash, {
              type: mapping.entity,
              standIn: mapping.standIn,
            });
          }
          addition.forms.push({
            length: form.length,
            roll: rolling.of(form),
            hash: formHash,
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
    onVerdict(listener) {
      verdictListeners.push(listener);
    },
    onReport(listener) {
      reportListeners.push(listener);
    },
    valueOfForm: (formHash) => ownerByHash.get(formHash) ?? null,
    hashForm: (form) => hash(form),
  };

  const tell = (category: NetCategory, result: VerifierResult | null): void => {
    for (const listener of verdictListeners) listener(category, result);
  };

  const answer = (id: number, result: VerifierResult): void => {
    doc.dispatchEvent(
      new CustomEvent(netChannelEvent(key, 'verdict'), {
        detail: JSON.stringify({
          id,
          block: result.block,
          possible: result.possible,
        }),
      }),
    );
  };
  const BLOCK: VerifierResult = {
    block: true,
    possible: 0,
    items: [],
    hashes: [],
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
    devlog(report.event, reportDetails(report));
    for (const listener of reportListeners) listener(report);
  });
  doc.addEventListener(netChannelEvent(key, 'verify'), (event) => {
    if (!(event instanceof CustomEvent)) return;
    const request = parseVerifyRequest(event.detail);
    if (!request) return;
    const current = verifier;
    if (current === null) {
      answer(request.id, BLOCK);
      tell(request.category, null);
      return;
    }
    current(request.texts, request.category).then(
      (result) => {
        answer(request.id, result);
        tell(request.category, result);
      },
      (error: unknown) => {
        devlog('net.failed', { error });
        answer(request.id, BLOCK);
        tell(request.category, null);
      },
    );
  });
  doc.addEventListener(NET_MAIN_HELLO, onHello);
  offer();

  return bridge;
}
