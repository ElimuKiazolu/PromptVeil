/**
 * Notices for writes PromptVeil stopped, and the early warning in card
 * editors (P6.4).
 *
 * Sources, all from this extension's side of the keyed channel (the page
 * cannot forge them; a notice never changes what is blocked):
 * - the full check's verdict on a fetch write (types from the detector);
 * - the net's block reports for the other transports: tier-1 emails
 *   (counted), tier-2 values masked earlier (types from their keyed forms),
 *   unreadable or uncheckable writes (no types);
 * - the early warning: card editors read (never changed, D-017) and checked
 *   after a pause in typing.
 *
 * Who caused a write decides whether it is shown:
 * - the site's own background writes (analytics, telemetry, anti-abuse, by
 *   evidence in the adapter) are blocked silently, whatever the user did;
 * - card notices sit under the card the user last typed in; message notices
 *   need user activity in the last 15 s;
 * - any other write is shown only when the user did something in the last
 *   15 s AND a value it was stopped for is one the user typed in that time.
 *   Typed values are remembered as keyed hashes only (the channel key, so
 *   they compare with the net's hashes), never as text.
 */
import type { SiteAdapter } from '@/src/adapters/types.ts';
import { createNoticeBoard, type NoticeView } from '@/src/core/notice/board.ts';
import {
  countItems,
  noticeSurfaceFor,
  type NoticeItem,
  type NoticeReason,
  type NoticeSurface,
} from '@/src/core/notice/text.ts';
import type { EntityType } from '@/src/shared/entities.ts';
import { devlog } from '@/src/shared/devlog.ts';
import type { NetCategory, NetReport } from '@/src/shared/net-protocol.ts';
import type { NoticeLayer, NoticePlacement } from '@/src/ui/notice/layer.ts';
import type { NetBridge } from './net-bridge.ts';

/** A card edit this recent is the one a card write belongs to. */
export const CARD_RECENT_MS = 30_000;
/** User activity this recent makes a page-level notice relevant. */
export const ACTIVITY_RECENT_MS = 15_000;
/** Pause in typing before a card editor or typed text is checked. */
export const CARD_PAUSE_MS = 300;

/** Input types never read (secrets the user types for the site itself). */
const UNREAD_INPUTS = new Set(['password', 'hidden', 'file']);

/** The element the user typed into and its text, or null. */
function editableText(
  target: EventTarget | null,
  adapter: SiteAdapter,
): { element: Element; text: string } | null {
  if (target instanceof HTMLTextAreaElement) {
    return { element: target, text: target.value };
  }
  if (target instanceof HTMLInputElement) {
    return UNREAD_INPUTS.has(target.type)
      ? null
      : { element: target, text: target.value };
  }
  const node =
    target instanceof Element
      ? target
      : target instanceof Node
        ? target.parentElement
        : null;
  const card = adapter.cardEditorFor?.(node) ?? null;
  if (card !== null && adapter.readCardText) {
    return { element: card, text: adapter.readCardText(card) };
  }
  const editable = node?.closest(
    '[contenteditable="true"], [contenteditable=""]',
  );
  return editable ? { element: editable, text: editable.textContent } : null;
}

export interface WriteNoticesOptions {
  readonly adapter: SiteAdapter;
  readonly net: Pick<NetBridge, 'onReport' | 'onVerdict' | 'valueOfForm'>;
  /** Builds the layer; called once, with the dismiss handler. */
  readonly createLayer: (onDismiss: (key: string) => void) => NoticeLayer;
  /** The values in a card's text that a write would be stopped for. */
  readonly scanCard: (text: string) => Promise<readonly NoticeItem[]>;
  /**
   * Keyed hashes of the compact forms of the values in typed text that a
   * write would be stopped for (the same hashes the net reports).
   */
  readonly scanTyped: (text: string) => Promise<readonly string[]>;
  readonly signal: AbortSignal;
  readonly now: () => number;
  readonly target?: Window;
  readonly pauseMs?: number;
  /**
   * Whether an event came from the user (default: isTrusted). Only user
   * events count as activity; page scripts cannot fake them.
   */
  readonly isUserEvent?: (event: Event) => boolean;
}

const USER_EVENTS = ['keydown', 'pointerdown', 'paste', 'drop'] as const;

export function startWriteNotices(options: WriteNoticesOptions): void {
  const { adapter, net, signal, now } = options;
  const target = options.target ?? window;
  const pauseMs = options.pauseMs ?? CARD_PAUSE_MS;
  const isUserEvent =
    options.isUserEvent ?? ((event: Event) => event.isTrusted);
  const board = createNoticeBoard({ now });
  const anchors = new Map<string, HTMLElement>();
  const cardKeys = new WeakMap<HTMLElement, string>();
  let cards = 0;
  let lastUserAt = -Infinity;
  let lastCard: { editor: HTMLElement; at: number } | null = null;
  const timers = new Map<HTMLElement, ReturnType<typeof setTimeout>>();
  const typedTimers = new Map<Element, ReturnType<typeof setTimeout>>();
  /** Keyed hashes of values the user typed, with when they were seen. */
  const typed = new Map<string, number>();
  /** Scans of typed text still running. */
  const scanning = new Set<Promise<void>>();
  /** Reads pending typed text at once (set below, used by \`blocked\`). */
  let settleTyped: () => Promise<void> = () => Promise.resolve();

  const apply = (view: NoticeView | null): void => {
    if (view === null || signal.aborted) return;
    if (!view.visible) {
      layer.hide(view.key);
      devlog('write-notice.hidden');
      return;
    }
    const anchor = anchors.get(view.key);
    const placement: NoticePlacement =
      anchor === undefined ? { kind: 'page' } : { kind: 'card', anchor };
    layer.show(view.key, view.content, placement, view.announce, view.tone);
    devlog('write-notice.shown', { surface: view.surface });
  };

  const layer = options.createLayer((key) => {
    apply(board.dismiss(key));
  });

  const keyOfCard = (editor: HTMLElement): string => {
    let key = cardKeys.get(editor);
    if (key === undefined) {
      cards += 1;
      key = `card:${cards.toString()}`;
      cardKeys.set(editor, key);
    }
    anchors.set(key, editor);
    return key;
  };

  /** The card a card write belongs to: the one typed in last, if recent. */
  const recentCard = (): HTMLElement | null =>
    lastCard !== null &&
    lastCard.editor.isConnected &&
    now() - lastCard.at <= CARD_RECENT_MS
      ? lastCard.editor
      : null;

  const userWasActive = (): boolean => now() - lastUserAt <= ACTIVITY_RECENT_MS;

  /** A blocked value is one the user typed in the activity window. */
  const wasTyped = (hashes: readonly string[]): boolean => {
    const since = now() - ACTIVITY_RECENT_MS;
    for (const [hash, at] of typed) if (at < since) typed.delete(hash);
    return hashes.some((hash) => typed.has(hash));
  };

  /** The notice key for a write, or null when no notice should show. */
  const keyFor = (
    surface: NoticeSurface,
    hashes: readonly string[],
  ): string | null => {
    if (surface === 'card') {
      const card = recentCard();
      if (card !== null) return keyOfCard(card);
    }
    if (!userWasActive()) return null;
    // An unknown write is the user's only when it carries what they typed.
    if (surface === 'write' && !wasTyped(hashes)) return null;
    return `page:${surface}`;
  };

  /**
   * A stopped write. `hashes`: keyed hashes of the values it was stopped
   * for (none when not known).
   */
  const blocked = (
    category: NetCategory,
    reason: NoticeReason,
    items: readonly NoticeItem[],
    hashes: readonly string[],
  ): void => {
    const surface = noticeSurfaceFor(category);
    if (surface === null) {
      devlog('write-notice.silent', { category });
      return;
    }
    const show = (): void => {
      const key = keyFor(surface, hashes);
      if (key !== null) apply(board.block(key, surface, reason, items));
    };
    const undecided =
      surface === 'write' &&
      hashes.length > 0 &&
      userWasActive() &&
      !wasTyped(hashes) &&
      (typedTimers.size > 0 || scanning.size > 0);
    if (!undecided) {
      show();
      return;
    }
    // Typed text not yet scanned may hold the value: decide after it.
    settleTyped().then(show, (error: unknown) => {
      devlog('prepass.failed', { error });
    });
  };

  const passed = (category: NetCategory): void => {
    const surface = noticeSurfaceFor(category);
    if (surface === null) return;
    if (surface === 'card') {
      const card = recentCard();
      if (card !== null) apply(board.pass(keyOfCard(card)));
    }
    apply(board.pass(`page:${surface}`));
  };

  /** Types of the values masked earlier that a tier-2 block found. */
  const itemsOfForms = (forms: readonly string[]): NoticeItem[] => {
    // A value can have several forms; its stand-in tells values apart.
    const values = new Map<string, EntityType>();
    for (const form of forms) {
      const owner = net.valueOfForm(form);
      if (owner !== null) values.set(owner.standIn, owner.type);
    }
    return countItems(
      [...values.values()].map((type) => ({ type, subtype: null })),
    );
  };

  net.onVerdict((category, result) => {
    if (result === null) blocked(category, 'unchecked', [], []);
    else if (result.block) {
      blocked(category, 'found', result.items, result.hashes);
    } else passed(category);
  });

  net.onReport((report: NetReport) => {
    if (report.event === 'net.failed') {
      blocked(report.category, 'unchecked', [], []);
      return;
    }
    if (report.event !== 'net.blocked') return;
    switch (report.cause) {
      case 'verified':
        // The verdict listener has shown it, with the detector's kinds.
        return;
      case 'email':
        blocked(
          report.category,
          'found',
          [{ type: 'EMAIL', subtype: null, count: report.emails }],
          report.forms,
        );
        return;
      case 'masked': {
        const items = itemsOfForms(report.forms);
        blocked(
          report.category,
          items.length > 0 ? 'earlier' : 'unchecked',
          items,
          report.forms,
        );
        return;
      }
      case 'unreadable':
        blocked(report.category, 'unchecked', [], []);
        return;
    }
  });

  /** Early warning: the card's text checked after a pause in typing. */
  const check = (editor: HTMLElement): void => {
    timers.delete(editor);
    if (signal.aborted || !editor.isConnected || !adapter.readCardText) return;
    const text = adapter.readCardText(editor);
    const started = now();
    options.scanCard(text).then(
      (items) => {
        devlog('write-notice.scanned', { ms: now() - started });
        if (signal.aborted || !editor.isConnected) return;
        apply(board.warn(keyOfCard(editor), items));
      },
      (error: unknown) => {
        // Best effort: the save itself is still checked, failing closed.
        devlog('prepass.failed', { error });
      },
    );
  };

  /** Remembers the keyed hashes of the values in text the user typed. */
  const remember = (element: Element): void => {
    typedTimers.delete(element);
    // Read after the pause: the text as it is now.
    const text = editableText(element, adapter)?.text ?? '';
    if (signal.aborted || text.trim() === '') return;
    const scan = options.scanTyped(text).then(
      (hashes) => {
        const at = now();
        for (const hash of hashes) typed.set(hash, at);
      },
      (error: unknown) => {
        // Best effort: without it, an unknown write's notice stays silent.
        devlog('prepass.failed', { error });
      },
    );
    scanning.add(scan);
    void scan.finally(() => scanning.delete(scan));
  };

  /**
   * Typed text still waiting for its pause (the user saved straight after
   * typing): read it now and wait for every scan.
   */
  settleTyped = async (): Promise<void> => {
    for (const [element, timer] of [...typedTimers]) {
      clearTimeout(timer);
      remember(element);
    }
    await Promise.all([...scanning]);
  };

  const listen = { capture: true, signal } as const;
  for (const type of USER_EVENTS) {
    target.addEventListener(
      type,
      (event) => {
        if (isUserEvent(event)) lastUserAt = now();
      },
      listen,
    );
  }
  target.addEventListener(
    'input',
    (event) => {
      if (!isUserEvent(event)) return;
      lastUserAt = now();
      const edited = editableText(event.target, adapter);
      if (edited !== null) {
        const { element } = edited;
        clearTimeout(typedTimers.get(element));
        typedTimers.set(
          element,
          setTimeout(() => {
            remember(element);
          }, pauseMs),
        );
      }
      const editor = adapter.cardEditorFor?.(event.target) ?? null;
      if (editor === null) return;
      lastCard = { editor, at: now() };
      clearTimeout(timers.get(editor));
      timers.set(
        editor,
        setTimeout(() => {
          check(editor);
        }, pauseMs),
      );
    },
    listen,
  );

  signal.addEventListener(
    'abort',
    () => {
      for (const timer of timers.values()) clearTimeout(timer);
      for (const timer of typedTimers.values()) clearTimeout(timer);
      timers.clear();
      typedTimers.clear();
      typed.clear();
      layer.dispose();
    },
    { once: true },
  );
}
