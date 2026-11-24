import { describe, expect, it } from 'vitest';
import {
  countItems,
  itemList,
  noticeText,
  type NoticeItem,
  type NoticeReason,
  type NoticeState,
  type NoticeSurface,
} from '@/src/core/notice/text.ts';
import {
  BANK_SUBTYPES,
  ENTITY_TYPES,
  NATIONAL_ID_SUBTYPES,
  type EntitySubtype,
  type EntityType,
} from '@/src/shared/entities.ts';

const item = (
  type: EntityType,
  count = 1,
  subtype: EntitySubtype | null = null,
): NoticeItem => ({ type, subtype, count });

const SURFACES: readonly NoticeSurface[] = ['card', 'message', 'write'];
const STATES: readonly NoticeState[] = ['warning', 'blocked'];
const REASONS: readonly NoticeReason[] = ['found', 'earlier', 'unchecked'];

describe('itemList', () => {
  it('counts each kind with its singular or plural label', () => {
    expect(itemList([item('EMAIL')])).toBe('1 email');
    expect(itemList([item('EMAIL', 2)])).toBe('2 emails');
    expect(itemList([item('EMAIL'), item('PHONE', 2)])).toBe(
      '1 email and 2 phone numbers',
    );
    expect(
      itemList([
        item('EMAIL'),
        item('PHONE'),
        item('NATIONAL_ID', 1, 'UK_NINO'),
      ]),
    ).toBe('1 email, 1 phone number and 1 UK NI number');
  });

  it('names national IDs and bank formats by subtype, else by type', () => {
    expect(itemList([item('NATIONAL_ID', 2, 'IT_CF')])).toBe(
      '2 codici fiscali',
    );
    expect(itemList([item('NATIONAL_ID', 2)])).toBe('2 national ID numbers');
    expect(itemList([item('BANK', 1, 'IBAN')])).toBe('1 bank account number');
    expect(itemList([item('SECRET', 2)])).toBe('2 API keys or passwords');
    expect(itemList([item('DOB', 2)])).toBe('2 dates of birth');
  });

  it('skips empty counts', () => {
    expect(itemList([item('EMAIL', 0), item('IP')])).toBe('1 IP address');
    expect(itemList([])).toBe('');
  });
});

describe('noticeText', () => {
  it('gives the approved card texts', () => {
    expect(noticeText('card', 'warning', 'found', [item('EMAIL')])).toEqual({
      title: 'Personal data in this card',
      body: "It has 1 email. While it's there, PromptVeil stops ChatGPT from saving this card, so your edits stay on this screen only. Remove it to keep saving.",
    });
    expect(noticeText('card', 'blocked', 'found', [item('EMAIL')])).toEqual({
      title: "This edit wasn't saved",
      body: 'It has 1 email. PromptVeil stopped ChatGPT from storing it. Remove it and your next edit will save; until then, edits are lost if you refresh.',
    });
  });

  it('gives the approved message and unknown-write texts', () => {
    expect(noticeText('message', 'blocked', 'found', [item('EMAIL')])).toEqual({
      title: 'Message not sent',
      body: "It has 1 email that wasn't replaced by a stand-in. Nothing was sent.",
    });
    expect(
      noticeText('message', 'blocked', 'found', [item('EMAIL', 2)]).body,
    ).toBe(
      "It has 2 emails that weren't replaced by a stand-in. Nothing was sent.",
    );
    expect(noticeText('write', 'blocked', 'found', [item('PHONE')])).toEqual({
      title: 'Not saved',
      body: 'Something you typed has 1 phone number. PromptVeil stopped ChatGPT from storing it. Remove it and try again.',
    });
  });

  it('names values masked earlier in this chat', () => {
    expect(noticeText('card', 'blocked', 'earlier', [item('PHONE')]).body).toBe(
      'It has 1 phone number you protected earlier in this chat. PromptVeil stopped ChatGPT from storing it. Remove it and your next edit will save; until then, edits are lost if you refresh.',
    );
  });

  it('says the write could not be checked when no types are known', () => {
    for (const surface of SURFACES) {
      for (const items of [[], [item('EMAIL')]]) {
        expect(noticeText(surface, 'blocked', 'unchecked', items).body).toBe(
          "PromptVeil couldn't check it, so it wasn't sent or saved.",
        );
      }
    }
    expect(noticeText('write', 'blocked', 'unchecked', []).title).toBe(
      'Not saved',
    );
  });

  it('uses only fixed words and counts, never "fake" or "surrogate"', () => {
    // Every type and subtype, every surface, state and reason.
    const all: NoticeItem[] = [
      ...ENTITY_TYPES.map((type) => item(type, 3)),
      ...NATIONAL_ID_SUBTYPES.map((s) => item('NATIONAL_ID', 1, s)),
      ...BANK_SUBTYPES.map((s) => item('BANK', 2, s)),
    ];
    for (const surface of SURFACES) {
      for (const state of STATES) {
        for (const reason of REASONS) {
          const { title, body } = noticeText(surface, state, reason, all);
          const text = `${title} ${body}`;
          expect(text).not.toMatch(/fake|surrogate/i);
          // Nothing but letters, digits as counts, and plain punctuation.
          expect(text).toMatch(/^[A-Za-z0-9 ,.;'/-]+$/);
        }
      }
    }
  });
});

describe('countItems', () => {
  it('counts by type and subtype in a fixed order', () => {
    expect(
      countItems([
        { type: 'PHONE', subtype: null },
        { type: 'NATIONAL_ID', subtype: 'UK_NINO' },
        { type: 'EMAIL', subtype: null },
        { type: 'PHONE', subtype: null },
      ]),
    ).toEqual([
      item('EMAIL'),
      item('PHONE', 2),
      item('NATIONAL_ID', 1, 'UK_NINO'),
    ]);
  });
});
