import { describe, expect, it } from 'vitest';
import { createNoticeBoard, type NoticeView } from '@/src/core/notice/board.ts';
import type { NoticeItem } from '@/src/core/notice/text.ts';

const EMAIL: NoticeItem = { type: 'EMAIL', subtype: null, count: 1 };
const PHONE: NoticeItem = { type: 'PHONE', subtype: null, count: 1 };

function setUp() {
  let time = 0;
  const board = createNoticeBoard({ now: () => time, announceGapMs: 5_000 });
  return {
    board,
    advance: (ms: number) => {
      time += ms;
    },
  };
}

const title = (view: NoticeView | null): string | null =>
  view?.visible === true ? view.content.title : null;

describe('notice board', () => {
  it('shows a blocked write once and updates it in place', () => {
    const { board, advance } = setUp();
    const first = board.block('card:1', 'card', 'found', [EMAIL]);
    expect(first).toMatchObject({ visible: true, announce: true });
    // The same block again (per-keystroke saves): nothing changes.
    expect(board.block('card:1', 'card', 'found', [EMAIL])).toBeNull();
    // Another value: updated, but announced only after the gap.
    advance(1_000);
    expect(
      board.block('card:1', 'card', 'found', [EMAIL, PHONE]),
    ).toMatchObject({ visible: true, announce: false });
    advance(5_000);
    expect(board.block('card:1', 'card', 'found', [PHONE])).toMatchObject({
      visible: true,
      announce: true,
    });
  });

  it('lets a block win over an early warning until a write passes', () => {
    const { board } = setUp();
    expect(title(board.warn('card:1', [EMAIL]))).toBe(
      'Personal data in this card',
    );
    expect(title(board.block('card:1', 'card', 'found', [EMAIL]))).toBe(
      "This edit wasn't saved",
    );
    // The value is removed while typing: the block stays until a save passes.
    expect(board.warn('card:1', [])).toBeNull();
    expect(board.pass('card:1')).toEqual({ key: 'card:1', visible: false });
  });

  it('hides an early warning when the value is removed', () => {
    const { board } = setUp();
    board.warn('card:1', [EMAIL]);
    expect(board.warn('card:1', [])).toEqual({ key: 'card:1', visible: false });
  });

  it('keeps a dismissed notice hidden until a new kind or a pass and a new block', () => {
    const { board } = setUp();
    board.block('write', 'write', 'found', [EMAIL]);
    expect(board.dismiss('write')).toEqual({ key: 'write', visible: false });
    expect(board.block('write', 'write', 'found', [EMAIL])).toBeNull();
    expect(title(board.block('write', 'write', 'found', [EMAIL, PHONE]))).toBe(
      'Not saved',
    );
    board.dismiss('write');
    board.pass('write');
    expect(title(board.block('write', 'write', 'found', [EMAIL]))).toBe(
      'Not saved',
    );
  });

  it('keeps an unchecked block dismissed until a pass', () => {
    const { board } = setUp();
    board.block('write', 'write', 'unchecked', []);
    board.dismiss('write');
    expect(board.block('write', 'write', 'unchecked', [])).toBeNull();
  });

  it('keeps notices of different keys apart', () => {
    const { board } = setUp();
    board.block('card:1', 'card', 'found', [EMAIL]);
    expect(board.block('card:2', 'card', 'found', [EMAIL])).toMatchObject({
      key: 'card:2',
      visible: true,
    });
    expect(board.pass('card:1')).toEqual({ key: 'card:1', visible: false });
    expect(board.pass('unknown')).toBeNull();
    expect(board.dismiss('unknown')).toBeNull();
    board.forget('card:2');
    expect(board.pass('card:2')).toBeNull();
  });
});
