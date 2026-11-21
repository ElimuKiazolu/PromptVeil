import { describe, expect, it } from 'vitest';
import { chatgptNetRules } from '@/src/adapters/chatgpt.ts';
import type { SiteNetRules } from '@/src/adapters/types.ts';
import type { BodyContent } from '@/src/net/body.ts';
import {
  loggedPath,
  parseRequestUrl,
  requestTexts,
} from '@/src/net/request.ts';

const MESSAGE_URL = new URL('https://chatgpt.com/backend-api/f/conversation');
const WRITING_BLOCK_URL = new URL(
  'https://chatgpt.com/backend-api/conversation/6acdb6c3-576c-83ee-9afa-959dd6bab8ce/writing-blocks',
);

/** The shape of a new-message request (ids and settings shortened). */
const newMessageBody = (text: string): string =>
  JSON.stringify({
    action: 'next',
    model: 'auto',
    conversation_id: '6acdb6c3-576c-83ee-9afa-959dd6bab8ce',
    messages: [
      {
        author: { role: 'user', name: null, metadata: {} },
        content: { content_type: 'text', parts: [text] },
        metadata: {},
      },
    ],
    timezone: 'Europe/London',
  });

/** A writing-block save as captured live (values fictional). */
const writingBlockBody = (
  content: string,
  recipient = 'olivia.hughes@example.net',
) =>
  JSON.stringify({
    conversation_id: '6acdb6c3-576c-83ee-9afa-959dd6bab8ce',
    message_id: 'd887b261-5f9e-4157-af90-a32139bd89f7',
    updated_at: '2026-11-21T10:15:00.000Z',
    writing_block: {
      content,
      metadata: {
        subject: 'Housewarming',
        recipient,
        suggested_followups: ['Make it shorter'],
      },
      variant: 'email',
    },
  });

const body = (...texts: string[]): BodyContent => ({
  texts,
  skipped: null,
  encoding: null,
  form: false,
});

const describeWrite = (
  url: URL,
  method: string,
  content: BodyContent,
  rules: SiteNetRules = chatgptNetRules,
) => requestTexts({ url, method, body: content }, rules).write;

describe('requestTexts', () => {
  it('collects all text for tier 2: URL parts, body and JSON strings', () => {
    const texts = requestTexts(
      {
        url: MESSAGE_URL,
        method: 'POST',
        body: body(newMessageBody('hi dana@example.com')),
      },
      chatgptNetRules,
    );
    expect(texts.all).toContain('hi dana@example.com');
    expect(texts.all).toContain('Europe/London');
  });

  it('describes no write for reads and for other sites', () => {
    expect(describeWrite(MESSAGE_URL, 'GET', body())).toBeNull();
    expect(
      describeWrite(new URL('https://example.org/api'), 'POST', body('x y')),
    ).toBeNull();
  });

  it('includes decoded URL parts', () => {
    const url = parseRequestUrl(
      '/collect?u=dana%40example.com#x=ops%40example.org',
      'https://chatgpt.com/c/abc',
    );
    const texts = requestTexts(
      { url, method: 'GET', body: body() },
      chatgptNetRules,
    );
    expect(texts.all).toContain('dana@example.com');
    expect(texts.all.join(' ')).toContain('ops@example.org');
  });

  it('decodes malformed percent sequences without throwing', () => {
    const url = parseRequestUrl(
      '/p/%E0%A4%A/dana%40example.com',
      'https://x.example/',
    );
    expect(() =>
      requestTexts({ url, method: 'GET', body: body() }, chatgptNetRules),
    ).not.toThrow();
  });

  it('copes with an unparseable URL', () => {
    expect(parseRequestUrl('http://[bad', 'https://x.example/')).toBeNull();
    expect(
      requestTexts(
        { url: null, method: 'POST', body: body('dana@example.com') },
        chatgptNetRules,
      ),
    ).toEqual({ all: ['dana@example.com'], write: null });
  });
});

describe('user text of first-party writes', () => {
  it('takes the message parts of a message request, not its settings', () => {
    const write = describeWrite(
      MESSAGE_URL,
      'POST',
      body(newMessageBody('hi there')),
    );
    expect(write?.surface).toBe('message');
    // Every string value of the content (content_type included), no keys.
    expect(write?.user).toEqual(['text', 'hi there']);
  });

  it('has no user text in a regenerate request', () => {
    const write = describeWrite(
      MESSAGE_URL,
      'POST',
      body(JSON.stringify({ action: 'variant', messages: [], model: 'auto' })),
    );
    expect(write?.user).toEqual([]);
  });

  it('takes the content, subject, recipient and follow-ups of a writing block', () => {
    const write = describeWrite(
      WRITING_BLOCK_URL,
      'POST',
      body(
        writingBlockBody('Dear Sam,\n\nSee you at 6.', 'sam_lee@example.com'),
      ),
    );
    expect(write?.surface).toBe('writing-block');
    expect(write?.user).toEqual([
      'Dear Sam,\n\nSee you at 6.',
      'Housewarming',
      'sam_lee@example.com',
      'Make it shorter',
    ]);
    expect(write?.fields).toEqual([
      'conversation_id',
      'message_id',
      'updated_at',
      'writing_block',
      'writing_block.content',
      'writing_block.metadata',
      'writing_block.variant',
      'writing_block.metadata.subject',
      'writing_block.metadata.recipient',
      'writing_block.metadata.suggested_followups',
    ]);
  });

  it('undoes the escaping ChatGPT applies to saved markdown', () => {
    const write = describeWrite(
      WRITING_BLOCK_URL,
      'POST',
      body(
        writingBlockBody(
          String.raw`Write&#x20;to sam\_lee\@example.com or 07400&#x20;123456`,
        ),
      ),
    );
    expect(write?.user[0]).toBe('Write to sam_lee@example.com or 07400 123456');
  });

  it('reads a writing block of an unexpected shape with the free-text selection', () => {
    const write = describeWrite(
      WRITING_BLOCK_URL,
      'PATCH',
      body(JSON.stringify({ block: { body: 'call 07400 123456' } })),
    );
    expect(write?.surface).toBe('writing-block');
    expect(write?.user).toEqual(['call 07400 123456']);
  });

  it('checks any other first-party write with the free-text selection', () => {
    const url = new URL(
      'https://chatgpt.com/backend-api/conversation/6acdb6c3-576c-83ee-9afa-959dd6bab8ce',
    );
    const write = describeWrite(
      url,
      'PATCH',
      body(JSON.stringify({ title: 'Notes for Dana', is_archived: false })),
    );
    expect(write?.surface).toBe('write');
    expect(write?.user).toEqual(['Notes for Dana']);
    expect(write?.fields).toEqual(['title', 'is_archived']);
  });

  it('leaves IDs, tokens and timestamps of a write unchecked', () => {
    const write = describeWrite(
      new URL('https://chatgpt.com/backend-api/sentinel/chat-requirements'),
      'POST',
      body(
        JSON.stringify({
          p: 'gAAAAABoQ3x9Zk1lM2V4YW1wbGVfdG9rZW5fdmFsdWU=',
          conversation_id: '6acdb6c3-576c-83ee-9afa-959dd6bab8ce',
          proof_token: 'has spaces but is a token',
          created_at: '2026-11-21T10:15:00.000Z',
          ts: '1791981861.681',
        }),
      ),
    );
    expect(write?.user).toEqual([]);
  });

  it('covers subdomains, every write method and WebSocket messages', () => {
    const ws = new URL('wss://ws.chatgpt.com/socket');
    for (const method of ['POST', 'PUT', 'PATCH', 'SEND']) {
      expect(describeWrite(ws, method, body('hello there'))).not.toBeNull();
    }
    expect(describeWrite(ws, 'DELETE', body('x y'))).toBeNull();
  });

  it('takes form bodies, plain text bodies and query values', () => {
    const url = new URL(
      'https://chatgpt.com/ces/v1/t?note=call%20me%20later&id=7',
    );
    const form: BodyContent = {
      texts: ['a=b%20c', 'a', 'b c'],
      skipped: null,
      encoding: null,
      form: true,
    };
    expect(describeWrite(url, 'POST', form)?.user).toEqual([
      'call me later',
      'b c',
    ]);
    expect(describeWrite(url, 'POST', body('07400123456'))?.user).toEqual([
      'call me later',
      '07400123456',
    ]);
    expect(
      describeWrite(
        url,
        'POST',
        body('gAAAAABoQ3x9Zk1lM2V4YW1wbGVfdG9rZW5fdmFsdWU='),
      )?.user,
    ).toEqual(['call me later']);
  });

  it('honours an exact skip entry, and nothing else', () => {
    const rules: SiteNetRules = {
      ...chatgptNetRules,
      skip: [
        {
          matches: (url, method) =>
            method === 'POST' && url.pathname === '/backend-api/known',
        },
      ],
    };
    const known = new URL('https://chatgpt.com/backend-api/known');
    const write = describeWrite(known, 'POST', body('{"note":"a b"}'), rules);
    expect(write?.skipped).toBe(true);
    expect(write?.user).toEqual([]);
    const near = new URL('https://chatgpt.com/backend-api/known/x');
    expect(
      describeWrite(near, 'POST', body('{"note":"a b"}'), rules)?.user,
    ).toEqual(['a b']);
  });
});

describe('loggedPath', () => {
  it('keeps words and replaces IDs and anything that is not a plain word', () => {
    expect(loggedPath(WRITING_BLOCK_URL)).toBe(
      '/backend-api/conversation/:id/writing-blocks',
    );
    expect(
      loggedPath(new URL('https://chatgpt.com/v1/rgstr?k=client-abc&gz=1')),
    ).toBe('/v1/rgstr');
    expect(
      loggedPath(
        new URL('https://chatgpt.com/backend-api/files/file-Ab12Cd/Dana'),
      ),
    ).toBe('/backend-api/files/:id/:id');
  });
});
