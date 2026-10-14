import { describe, expect, it } from 'vitest';
import { chatgptNetRules } from '@/src/adapters/chatgpt.ts';
import { parseRequestUrl, requestTexts } from '@/src/net/request.ts';

const MESSAGE_URL = new URL('https://chatgpt.com/backend-api/f/conversation');

/** The shape of a new-message request (ids and settings removed). */
const newMessageBody = (text: string): string =>
  JSON.stringify({
    action: 'next',
    model: 'auto',
    messages: [
      {
        author: { role: 'user', name: null, metadata: {} },
        content: { content_type: 'text', parts: [text] },
        metadata: {},
      },
    ],
    timezone: 'Europe/London',
  });

const body = (...texts: string[]) => ({ texts, skippedBinary: false });

describe('requestTexts', () => {
  it('extracts the message parts of a message request', () => {
    const texts = requestTexts(
      {
        url: MESSAGE_URL,
        method: 'POST',
        body: body(newMessageBody('hi dana@example.com')),
      },
      chatgptNetRules,
    );
    expect(texts.message).toContain('hi dana@example.com');
    expect(texts.all).toContain('hi dana@example.com');
  });

  it('has no message text for other requests', () => {
    const texts = requestTexts(
      {
        url: new URL('https://chatgpt.com/backend-api/settings'),
        method: 'POST',
        body: body('{"email":"me@example.org"}'),
      },
      chatgptNetRules,
    );
    expect(texts.message).toBeNull();
    expect(texts.all).toContain('me@example.org');
  });

  it('checks every string of an unexpected message body', () => {
    const texts = requestTexts(
      {
        url: MESSAGE_URL,
        method: 'POST',
        body: body('{"prompt":"dana@example.com"}'),
      },
      chatgptNetRules,
    );
    expect(texts.message).toContain('dana@example.com');
  });

  it('checks a non-JSON message body as plain text', () => {
    const texts = requestTexts(
      { url: MESSAGE_URL, method: 'POST', body: body('dana@example.com') },
      chatgptNetRules,
    );
    expect(texts.message).toEqual(['dana@example.com']);
  });

  it('has no message text for a regenerate request', () => {
    const texts = requestTexts(
      {
        url: MESSAGE_URL,
        method: 'POST',
        body: body(JSON.stringify({ action: 'variant', messages: [] })),
      },
      chatgptNetRules,
    );
    expect(texts.message).toEqual([]);
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
    const texts = requestTexts(
      { url: null, method: 'POST', body: body('dana@example.com') },
      chatgptNetRules,
    );
    expect(texts).toEqual({ all: ['dana@example.com'], message: null });
  });
});
