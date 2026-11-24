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
 * Card notices sit under the card the user last typed in. Other notices
 * appear only when the user did something on the page shortly before, so a
 * stopped background request (e.g. telemetry carrying a masked value) stays
 * silent.
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
/** Pause in typing before a card editor is checked. */
export const CARD_PAUSE_MS = 300;

export interface WriteNoticesOptions {
  readonly adapter: SiteAdapter;
  readonly net: Pick<NetBridge, 'onReport' | 'onVerdict' | 'valueOfForm'>;
  /** Builds the layer; called once, with the dismiss handler. */
  readonly createLayer: (onDismiss: (key: string) => void) => NoticeLayer;
  /** The values in a card's text that a write would be stopped for. */
  readonly scanCard: (text: string) => Promise<readonly NoticeItem[]>;
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
    layer.show(view.key, view.content, placement, view.announce);
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

  /** The notice key for a write, or null when no notice should show. */
  const keyFor = (surface: NoticeSurface): string | null => {
    if (surface === 'card') {
      const card = recentCard();
      if (card !== null) return keyOfCard(card);
    }
    return userWasActive() ? `page:${surface}` : null;
  };

  const blocked = (
    category: NetCategory,
    reason: NoticeReason,
    items: readonly NoticeItem[],
  ): void => {
    const surface = noticeSurfaceFor(category);
    const key = keyFor(surface);
    if (key !== null) apply(board.block(key, surface, reason, items));
  };

  const passed = (category: NetCategory): void => {
    const surface = noticeSurfaceFor(category);
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
    if (result === null) blocked(category, 'unchecked', []);
    else if (result.block) blocked(category, 'found', result.items);
    else passed(category);
  });

  net.onReport((report: NetReport) => {
    if (report.event === 'net.failed') {
      blocked(report.category, 'unchecked', []);
      return;
    }
    if (report.event !== 'net.blocked') return;
    switch (report.cause) {
      case 'verified':
        // The verdict listener has shown it, with the detector's kinds.
        return;
      case 'email':
        blocked(report.category, 'found', [
          { type: 'EMAIL', subtype: null, count: report.emails },
        ]);
        return;
      case 'masked': {
        const items = itemsOfForms(report.forms);
        blocked(
          report.category,
          items.length > 0 ? 'earlier' : 'unchecked',
          items,
        );
        return;
      }
      case 'unreadable':
        blocked(report.category, 'unchecked', []);
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
      timers.clear();
      layer.dispose();
    },
    { once: true },
  );
}
