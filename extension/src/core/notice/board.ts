/**
 * Decides what each notice shows. One notice per key (a card, or a
 * page-level surface): later events update it in place, never add another.
 *
 * - A blocked write wins over an early warning; it stays until a write of
 *   the same key passes.
 * - A dismissed notice comes back only when a new kind of value appears, or
 *   when a write passed and a later one is blocked again.
 * - Screen readers hear a notice when it first shows and when its text
 *   changes, at most once every `announceGapMs`.
 */
import {
  noticeText,
  type NoticeContent,
  type NoticeItem,
  type NoticeReason,
  type NoticeSurface,
} from './text.ts';

export const ANNOUNCE_GAP_MS = 5_000;

export type NoticeView =
  | { readonly key: string; readonly visible: false }
  | {
      readonly key: string;
      readonly visible: true;
      readonly surface: NoticeSurface;
      readonly content: NoticeContent;
      /** Read the text out (live region) this time. */
      readonly announce: boolean;
    };

export interface NoticeBoard {
  /** Early warning: values found while typing in a card. */
  warn(key: string, items: readonly NoticeItem[]): NoticeView | null;
  /** A write was stopped. */
  block(
    key: string,
    surface: NoticeSurface,
    reason: NoticeReason,
    items: readonly NoticeItem[],
  ): NoticeView | null;
  /** A write of this key went through. */
  pass(key: string): NoticeView | null;
  /** The user closed the notice. */
  dismiss(key: string): NoticeView | null;
  /** Forgets a key (its card left the page). */
  forget(key: string): void;
}

interface Entry {
  surface: NoticeSurface;
  warning: readonly NoticeItem[];
  blocked: { reason: NoticeReason; items: readonly NoticeItem[] } | null;
  /** Kinds shown when the user dismissed it; null when not dismissed. */
  dismissed: ReadonlySet<string> | null;
  /** Text last rendered (null: hidden). */
  shown: string | null;
  announced: string | null;
  announcedAt: number;
}

const kindOf = (item: NoticeItem): string =>
  `${item.type}|${item.subtype ?? ''}`;

export function createNoticeBoard(options: {
  now: () => number;
  announceGapMs?: number;
}): NoticeBoard {
  const gap = options.announceGapMs ?? ANNOUNCE_GAP_MS;
  const entries = new Map<string, Entry>();

  const entryFor = (key: string, surface: NoticeSurface): Entry => {
    let entry = entries.get(key);
    if (entry === undefined) {
      entry = {
        surface,
        warning: [],
        blocked: null,
        dismissed: null,
        shown: null,
        announced: null,
        announcedAt: -Infinity,
      };
      entries.set(key, entry);
    }
    return entry;
  };

  const contentOf = (entry: Entry): NoticeContent | null => {
    if (entry.blocked !== null) {
      return noticeText(
        entry.surface,
        'blocked',
        entry.blocked.reason,
        entry.blocked.items,
      );
    }
    if (entry.warning.length > 0) {
      return noticeText(entry.surface, 'warning', 'found', entry.warning);
    }
    return null;
  };

  const currentKinds = (entry: Entry): string[] =>
    (entry.blocked?.items ?? entry.warning).map(kindOf);

  /** Renders the entry; null when nothing visible changed. */
  const render = (key: string, entry: Entry): NoticeView | null => {
    const content = contentOf(entry);
    const { dismissed } = entry;
    const stillDismissed =
      dismissed !== null &&
      currentKinds(entry).every((kind) => dismissed.has(kind));
    if (content === null || stillDismissed) {
      if (entry.shown === null) return null;
      entry.shown = null;
      return { key, visible: false };
    }
    // A new kind of value brings a dismissed notice back.
    entry.dismissed = null;
    const text = `${content.title}\n${content.body}`;
    if (text === entry.shown) return null;
    const firstShow = entry.shown === null;
    entry.shown = text;
    const at = options.now();
    const announce =
      text !== entry.announced && (firstShow || at - entry.announcedAt >= gap);
    if (announce) {
      entry.announced = text;
      entry.announcedAt = at;
    }
    return { key, visible: true, surface: entry.surface, content, announce };
  };

  return {
    warn(key, items) {
      const entry = entryFor(key, 'card');
      entry.warning = items.filter((item) => item.count > 0);
      return render(key, entry);
    },
    block(key, surface, reason, items) {
      const entry = entryFor(key, surface);
      entry.surface = surface;
      entry.blocked = { reason, items: items.filter((item) => item.count > 0) };
      return render(key, entry);
    },
    pass(key) {
      const entry = entries.get(key);
      if (entry === undefined) return null;
      entry.blocked = null;
      entry.dismissed = null;
      return render(key, entry);
    },
    dismiss(key) {
      const entry = entries.get(key);
      if (entry?.shown == null) return null;
      entry.dismissed = new Set(currentKinds(entry));
      entry.shown = null;
      return { key, visible: false };
    },
    forget(key) {
      entries.delete(key);
    },
  };
}
