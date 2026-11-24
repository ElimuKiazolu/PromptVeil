import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createChatGptAdapter } from '@/src/adapters/chatgpt.ts';
import type {
  FormOwner,
  VerdictListener,
  VerifierResult,
} from '@/src/content/net-bridge.ts';
import {
  ACTIVITY_RECENT_MS,
  CARD_RECENT_MS,
  startWriteNotices,
} from '@/src/content/write-notices.ts';
import type { NoticeContent, NoticeItem } from '@/src/core/notice/text.ts';
import type { NetBlockedReport, NetReport } from '@/src/shared/net-protocol.ts';
import type { NoticeLayer, NoticePlacement } from '@/src/ui/notice/layer.ts';

const EMAIL: NoticeItem = { type: 'EMAIL', subtype: null, count: 1 };
const read = (file: string) =>
  readFileSync(resolve(`tests/fixtures/sites/chatgpt/${file}`), 'utf8');

/** The composer and a writing card on one page (no innerHTML). */
function loadPage(): HTMLElement {
  const parsed = new DOMParser().parseFromString(
    read('composer.html') + read('reply-writing-block.html'),
    'text/html',
  );
  document.body.replaceChildren(
    ...Array.from(parsed.body.childNodes, (node) =>
      document.importNode(node, true),
    ),
  );
  const card = document.querySelector<HTMLElement>(
    '.writing-block-editor .ProseMirror',
  );
  if (!card) throw new Error('no card');
  return card;
}

interface Shown {
  content: NoticeContent;
  placement: NoticePlacement;
  announce: boolean;
}

function setUp(
  scanCard = vi.fn<(text: string) => Promise<NoticeItem[]>>(() =>
    Promise.resolve([]),
  ),
) {
  const card = loadPage();
  let time = 1_000_000;
  const controller = new AbortController();
  const reportListeners: ((report: NetReport) => void)[] = [];
  const verdictListeners: VerdictListener[] = [];
  const owners = new Map<string, FormOwner>();
  const shown = new Map<string, Shown>();
  const calls: string[] = [];
  const dispose = vi.fn();
  let dismiss: (key: string) => void = () => undefined;
  const layer: NoticeLayer = {
    show(key, content, placement, announce) {
      shown.set(key, { content, placement, announce });
      calls.push(`show ${key}`);
    },
    hide(key) {
      shown.delete(key);
      calls.push(`hide ${key}`);
    },
    dispose,
  };
  startWriteNotices({
    adapter: createChatGptAdapter(),
    net: {
      onReport: (listener) => reportListeners.push(listener),
      onVerdict: (listener) => verdictListeners.push(listener),
      valueOfForm: (hash) => owners.get(hash) ?? null,
    },
    createLayer: (onDismiss) => {
      dismiss = onDismiss;
      return layer;
    },
    scanCard,
    signal: controller.signal,
    now: () => time,
    pauseMs: 300,
    // jsdom cannot make trusted events; the tests' events stand for them.
    isUserEvent: () => true,
  });
  return {
    card,
    shown,
    calls,
    dispose,
    owners,
    controller,
    scanCard,
    advance: (ms: number) => {
      time += ms;
    },
    report: (report: Partial<NetBlockedReport> | NetReport) => {
      for (const listener of reportListeners) {
        listener({
          event: 'net.blocked',
          tier: 1,
          category: 'write',
          transport: 'xhr',
          cause: 'email',
          emails: 1,
          forms: [],
          ...report,
        } as NetReport);
      }
    },
    verdict: (
      category: 'writing-block' | 'write',
      result: VerifierResult | null,
    ) => {
      for (const listener of verdictListeners) listener(category, result);
    },
    typeInCard: () => {
      card.dispatchEvent(new Event('input', { bubbles: true }));
    },
    click: () => {
      document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    },
    dismiss: (key: string) => {
      dismiss(key);
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
  document.body.replaceChildren();
});

describe('write notices', () => {
  it('puts a blocked card save under the card the user typed in', () => {
    const t = setUp();
    t.typeInCard();
    t.verdict('writing-block', { block: true, possible: 0, items: [EMAIL] });
    const [notice] = [...t.shown.values()];
    expect(notice?.content.title).toBe("This edit wasn't saved");
    expect(notice?.placement).toEqual({ kind: 'card', anchor: t.card });
    expect(notice?.announce).toBe(true);
  });

  it('hides the card notice when a later save of that card passes', () => {
    const t = setUp();
    t.typeInCard();
    t.verdict('writing-block', { block: true, possible: 0, items: [EMAIL] });
    t.typeInCard();
    t.verdict('writing-block', { block: false, possible: 0, items: [] });
    expect(t.shown.size).toBe(0);
  });

  it('updates one notice for per-keystroke saves instead of stacking', () => {
    const t = setUp();
    for (let i = 0; i < 5; i += 1) {
      t.typeInCard();
      t.verdict('writing-block', { block: true, possible: 0, items: [EMAIL] });
    }
    expect(t.calls).toEqual(['show card:1']);
  });

  it('shows a page-level notice for other writes after user activity only', () => {
    const t = setUp();
    t.report({ category: 'write', emails: 2 });
    expect(t.shown.size).toBe(0);
    t.click();
    t.report({ category: 'write', emails: 2 });
    expect(t.shown.get('page:write')?.content.body).toBe(
      'Something you typed has 2 emails. PromptVeil stopped ChatGPT from storing it. Remove it and try again.',
    );
    expect(t.shown.get('page:write')?.placement).toEqual({ kind: 'page' });
    // Activity long ago: a background request stays silent.
    t.advance(ACTIVITY_RECENT_MS + 1);
    t.report({ category: 'message', emails: 1 });
    expect(t.shown.has('page:message')).toBe(false);
  });

  it('moves a card save to page level once the card edit is old', () => {
    const t = setUp();
    t.typeInCard();
    t.advance(CARD_RECENT_MS + 1);
    t.click();
    t.verdict('writing-block', { block: true, possible: 0, items: [EMAIL] });
    expect(t.shown.get('page:card')?.placement).toEqual({ kind: 'page' });
  });

  it('names values masked earlier by type, each value once', () => {
    const t = setUp();
    t.owners.set('a'.repeat(64), { type: 'PHONE', standIn: '07700 900123' });
    t.owners.set('b'.repeat(64), { type: 'PHONE', standIn: '07700 900123' });
    t.owners.set('c'.repeat(64), { type: 'EMAIL', standIn: 'x@example.net' });
    t.click();
    t.report({
      tier: 2,
      cause: 'masked',
      emails: 0,
      forms: ['a'.repeat(64), 'b'.repeat(64), 'c'.repeat(64)],
    });
    expect(t.shown.get('page:write')?.content.body).toBe(
      'Something you typed has 1 email and 1 phone number you protected earlier in this chat. PromptVeil stopped ChatGPT from storing it. Remove it and try again.',
    );
  });

  it('says a write could not be checked when no types are known', () => {
    const t = setUp();
    t.click();
    t.report({ cause: 'unreadable', emails: 0 });
    expect(t.shown.get('page:write')?.content.body).toBe(
      "PromptVeil couldn't check it, so it wasn't sent or saved.",
    );
    t.verdict('write', null);
    expect(t.calls).toEqual(['show page:write']);
    t.report({ event: 'net.failed', category: 'message', transport: 'fetch' });
    expect(t.shown.get('page:message')?.content.title).toBe('Message not sent');
  });

  it('leaves blocks the full check explained to the verdict', () => {
    const t = setUp();
    t.click();
    t.report({ cause: 'verified', emails: 0 });
    expect(t.shown.size).toBe(0);
  });

  it('keeps a dismissed notice closed for the same kinds', () => {
    const t = setUp();
    t.click();
    t.report({ category: 'write', emails: 1 });
    t.dismiss('page:write');
    expect(t.shown.size).toBe(0);
    t.report({ category: 'write', emails: 1 });
    expect(t.shown.size).toBe(0);
  });

  it('warns while typing in a card, before any save, reading it only', async () => {
    vi.useFakeTimers();
    const scanCard = vi.fn<(text: string) => Promise<NoticeItem[]>>(() =>
      Promise.resolve([EMAIL]),
    );
    const t = setUp(scanCard);
    const before = t.card.cloneNode(true);
    t.typeInCard();
    t.typeInCard();
    await vi.advanceTimersByTimeAsync(299);
    expect(scanCard).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    // One check after the pause, on the card's text.
    expect(scanCard).toHaveBeenCalledTimes(1);
    expect(scanCard.mock.calls[0]?.[0]).toContain('Housewarming Invitation');
    expect(t.shown.get('card:1')?.content.title).toBe(
      'Personal data in this card',
    );
    expect(t.card.isEqualNode(before)).toBe(true);
    // The value removed: the warning goes.
    scanCard.mockResolvedValue([]);
    t.typeInCard();
    await vi.advanceTimersByTimeAsync(300);
    expect(t.shown.size).toBe(0);
  });

  it('ignores typing outside card editors', async () => {
    vi.useFakeTimers();
    const t = setUp();
    document
      .querySelector('form[data-chatgpt-composer] [contenteditable="true"]')
      ?.dispatchEvent(new Event('input', { bubbles: true }));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(t.scanCard).not.toHaveBeenCalled();
  });

  it('stops and removes the layer when aborted', async () => {
    vi.useFakeTimers();
    const t = setUp();
    t.typeInCard();
    t.controller.abort();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(t.scanCard).not.toHaveBeenCalled();
    expect(t.dispose).toHaveBeenCalled();
  });
});
