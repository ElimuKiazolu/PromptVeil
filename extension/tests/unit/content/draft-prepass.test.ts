import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_PAUSE_MS,
  startDraftPrepass,
} from '@/src/content/draft-prepass.ts';
import { createMainThreadYielder } from '@/src/content/yielder.ts';
import { setUp, type Harness } from './harness.ts';

function type(editor: HTMLElement, text: string): void {
  editor.textContent = text;
  editor.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('startDraftPrepass', () => {
  let h: Harness;
  let controller: AbortController;
  let prepare: ReturnType<typeof vi.fn<(text: string) => Promise<void>>>;

  beforeEach(() => {
    vi.useFakeTimers();
    h = setUp();
    controller = new AbortController();
    prepare = vi.fn(() => Promise.resolve());
    startDraftPrepass({
      adapter: h.adapter,
      prepare,
      signal: controller.signal,
    });
  });

  afterEach(() => {
    controller.abort();
    vi.useRealTimers();
  });

  it('analyses the draft after a pause in typing', () => {
    type(h.editor, 'Mail d');
    vi.advanceTimersByTime(DEFAULT_PAUSE_MS - 1);
    type(h.editor, 'Mail dana@example.com');
    vi.advanceTimersByTime(DEFAULT_PAUSE_MS - 1);
    expect(prepare).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(prepare.mock.calls).toEqual([['Mail dana@example.com']]);
  });

  it('analyses straight after a paste or a drop, without waiting for a pause', () => {
    h.editor.textContent = 'pasted dana@example.com';
    h.editor.dispatchEvent(new Event('paste', { bubbles: true }));
    vi.advanceTimersByTime(0);
    expect(prepare.mock.calls).toEqual([['pasted dana@example.com']]);
    h.edit.editor.textContent = 'dropped text';
    h.edit.editor.dispatchEvent(new Event('drop', { bubbles: true }));
    vi.advanceTimersByTime(0);
    expect(prepare.mock.calls.at(-1)).toEqual(['dropped text']);
  });

  it('ignores events outside the composers and empty drafts', () => {
    h.message.dispatchEvent(new Event('input', { bubbles: true }));
    type(h.editor, '   ');
    vi.advanceTimersByTime(DEFAULT_PAUSE_MS);
    expect(prepare).not.toHaveBeenCalled();
  });

  it('survives a failing read or a failing analysis', async () => {
    h.composer.readPrompt = () => {
      throw new Error('editor gone');
    };
    type(h.editor, 'x');
    expect(() => vi.advanceTimersByTime(DEFAULT_PAUSE_MS)).not.toThrow();
    expect(prepare).not.toHaveBeenCalled();
    h.composer.readPrompt = () => h.editor.textContent;
    prepare.mockRejectedValueOnce(new Error('rules failed'));
    type(h.editor, 'y');
    vi.advanceTimersByTime(DEFAULT_PAUSE_MS);
    await Promise.resolve();
    expect(prepare).toHaveBeenCalledTimes(1);
  });

  it('stops when aborted, including a pending pause', () => {
    type(h.editor, 'pending');
    controller.abort();
    vi.advanceTimersByTime(DEFAULT_PAUSE_MS);
    type(h.editor, 'after');
    vi.advanceTimersByTime(DEFAULT_PAUSE_MS);
    expect(prepare).not.toHaveBeenCalled();
  });
});

describe('createMainThreadYielder', () => {
  it('resumes in a later task, in order', async () => {
    const yielder = createMainThreadYielder();
    const order: number[] = [];
    await Promise.all([
      yielder.yieldNow().then(() => order.push(1)),
      yielder.yieldNow().then(() => order.push(2)),
    ]);
    expect(order).toEqual([1, 2]);
    expect(yielder.now()).toBeGreaterThan(0);
    yielder.close();
  });

  it('releases waiting work on close and does not wait afterwards', async () => {
    const yielder = createMainThreadYielder();
    const pending = yielder.yieldNow();
    yielder.close();
    await expect(pending).resolves.toBeUndefined();
    await expect(yielder.yieldNow()).resolves.toBeUndefined();
  });
});
