import { describe, expect, it } from 'vitest';
import {
  freeTextStrings,
  isFreeText,
  isIdKey,
  isTextKey,
  isTokenShaped,
  keyNames,
} from '@/src/core/net/user-text.ts';

describe('key names', () => {
  it.each([
    'id',
    'conversation_id',
    'parent_message_id',
    'messageId',
    'message_ids',
    'token',
    'access_token',
    'proof',
    'proof-token',
    'nonce',
    'hash',
    'signature',
  ])('%s is an ID or token key', (key) => {
    expect(isIdKey(key)).toBe(true);
  });

  it.each(['hidden', 'paid', 'valid', 'android', 'content', 'name', 'model'])(
    '%s is not an ID key',
    (key) => {
      expect(isIdKey(key)).toBe(false);
    },
  );

  it.each([
    'content',
    'title',
    'subject',
    'recipient',
    'email',
    'phone',
    'instructions',
    'about_user_message',
    'displayName',
    'parts',
  ])('%s is a text key', (key) => {
    expect(isTextKey(key)).toBe(true);
  });
});

describe('isTokenShaped', () => {
  it.each([
    '6acdb6c3-576c-83ee-9afa-959dd6bab8ce',
    'gAAAAABoQ3x9Zk1lM2V4YW1wbGVfdG9rZW5fdmFsdWU=',
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl',
    '2026-11-21T10:15:00.000Z',
    'file-Ab12Cd34Ef56Gh78',
    // A sentinel proof value: a base64 run with a "~S" suffix.
    'gAAAAABWzE1vbiBOb3YgMjQgMjAyNiIsMC40MzIxXQ==~S',
  ])('%s is token-shaped', (value) => {
    expect(isTokenShaped(value)).toBe(true);
  });

  it.each([
    'dana@example.com',
    'hello world',
    '07400123456',
    'Europe/London',
    'auto',
    'AB123456C',
    // Markdown strikethrough around typed text stays text.
    '~~07400123456~~',
    '~~call me~~',
  ])('%s is not token-shaped', (value) => {
    expect(isTokenShaped(value)).toBe(false);
  });
});

describe('isFreeText', () => {
  it('takes strings with spaces, markdown or "@"', () => {
    expect(isFreeText('note', 'call me tomorrow')).toBe(true);
    expect(isFreeText(null, String.raw`sam\_lee`)).toBe(true);
    expect(isFreeText('x', 'dana@example.com')).toBe(true);
  });

  it('takes any string under a text key, even a single token', () => {
    expect(isFreeText('phone', '07400123456')).toBe(true);
    expect(isFreeText('title', 'Payroll')).toBe(true);
  });

  it('never takes ID or token keys, whatever the value', () => {
    expect(isFreeText('conversation_id', 'has spaces in it')).toBe(false);
    expect(isFreeText('proof_token', 'gAAAA dana@example.com')).toBe(false);
  });

  it('leaves out machine values: single words, timestamps, tokens', () => {
    for (const value of [
      'auto',
      'next',
      'Europe/London',
      '1791981861.681',
      '2026-11-21T10:15:00.000Z',
      'gAAAAABoQ3x9Zk1lM2V4YW1wbGVfdG9rZW5fdmFsdWU=',
      '',
    ]) {
      expect(isFreeText('model', value)).toBe(false);
    }
  });
});

describe('freeTextStrings', () => {
  it('selects the free text of a body and skips its machine fields', () => {
    const body = {
      conversation_id: '6acdb6c3-576c-83ee-9afa-959dd6bab8ce',
      timezone: 'Europe/London',
      timezone_offset_min: -60,
      model: 'auto',
      proof: 'gAAAAABoQ3x9Zk1lM2V4YW1wbGVfdG9rZW5fdmFsdWU=',
      updated_at: '2026-11-21T10:15:00.000Z',
      item: { title: 'Q3 plan', note: 'send it to dana@example.com' },
      tags: ['draft', 'call 07400 123456 first'],
      message_ids: ['has a space', 'also'],
    };
    expect(freeTextStrings(body).sort()).toEqual(
      [
        'Q3 plan',
        'call 07400 123456 first',
        'send it to dana@example.com',
      ].sort(),
    );
  });

  it('never returns object keys', () => {
    expect(freeTextStrings({ 'dana@example.com': 1 })).toEqual([]);
  });

  it('handles scalars, arrays and deep nesting', () => {
    expect(freeTextStrings('hello world')).toEqual(['hello world']);
    expect(freeTextStrings(null)).toEqual([]);
    let deep: unknown = 'too deep to matter';
    for (let i = 0; i < 100; i += 1) deep = { child: deep };
    expect(freeTextStrings(deep)).toEqual([]);
  });
});

describe('keyNames', () => {
  it('lists top-level keys and the keys of named nested objects', () => {
    const body = {
      conversation_id: 'x',
      writing_block: {
        content: 'x',
        metadata: { subject: 's', recipient: 'r' },
        variant: 'email',
      },
    };
    expect(keyNames(body, ['writing_block', 'writing_block.metadata'])).toEqual(
      [
        'conversation_id',
        'writing_block',
        'writing_block.content',
        'writing_block.metadata',
        'writing_block.variant',
        'writing_block.metadata.subject',
        'writing_block.metadata.recipient',
      ],
    );
  });

  it('prints keys that could be data as "?"', () => {
    expect(keyNames({ 'dana@example.com': 1, 'a b': 2, ok: 3 })).toEqual([
      '?',
      '?',
      'ok',
    ]);
  });

  it('has no keys for arrays, scalars and missing paths', () => {
    expect(keyNames([1, 2], ['a.b'])).toEqual([]);
    expect(keyNames('text')).toEqual([]);
  });
});

describe('sentinel requests (P6.5 live finding)', () => {
  it('select no user text from a proof ending in "~S" or a turnstile token', () => {
    // Shapes as logged live: prepare_token, proofofwork, turnstile; values
    // are made up here (base64 of fixed bytes).
    const run = (n: number) =>
      Buffer.from(Array.from({ length: n }, (_, i) => (i * 37) % 256)).toString(
        'base64',
      );
    const body = {
      prepare_token: `gAAAAAC${run(300)}`,
      proofofwork: `gAAAAAB${run(400)}~S`,
      turnstile: `${run(400)}~${run(400)}`,
    };
    expect(freeTextStrings(body)).toEqual([]);
  });
});
