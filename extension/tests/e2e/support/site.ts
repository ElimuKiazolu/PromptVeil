/**
 * The local chatgpt.com copy: sanitised ChatGPT fixtures, the page script in
 * page.ts, a nonce-only CSP like ChatGPT's, and a server that stores
 * conversations and records every request, so checks can confirm what
 * reached "the site". A second host (other.test) is a plain page on another
 * site, for leaving and coming back.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:https';
import type { AddressInfo } from 'node:net';
import { selfSignedCertificate } from './cert.ts';
import { pageScript } from './page.ts';

export const SITE_HOST = 'chatgpt.com';
export const OTHER_HOST = 'other.test';
const NONCE = 'r3c0rdNonce';
const FIXTURES = new URL('../../fixtures/sites/chatgpt/', import.meta.url);

export interface RecordedRequest {
  readonly host: string;
  readonly method: string;
  readonly url: string;
  readonly body: string;
  readonly at: number;
}

export interface Card {
  readonly recipient: string;
  readonly text: string;
}

export interface Reply {
  readonly text: string;
  readonly card?: Card;
}

/** Builds the assistant's reply to a received prompt; null = default. */
export type ReplyHandler = (prompt: string) => Reply | null;

interface StoredMessage {
  readonly role: 'user' | 'assistant';
  readonly text: string;
  readonly card?: Card;
}

export interface Site {
  readonly port: number;
  readonly requests: readonly RecordedRequest[];
  /** Message texts as the site received them, in order. */
  readonly prompts: readonly string[];
  /** Replaces the reply builder until reset with null. */
  replyWith(handler: ReplyHandler | null): void;
  close(): Promise<void>;
}

/** Default replies: echo, plus a writing card for "Draft an email to X". */
function defaultReply(prompt: string): Reply {
  const draft = /^Draft an email to (\S+@\S+?)[ ,.]/.exec(prompt);
  if (draft?.[1]) {
    return {
      text: 'Here is a draft you can edit.',
      card: {
        recipient: draft[1],
        text: 'Dear team, the plan is below. Regards',
      },
    };
  }
  return { text: `Noted: ${prompt}` };
}

function fixture(name: string): string {
  return readFileSync(new URL(name, FIXTURES), 'utf8');
}

/** Marks the fixture element whose text the page fills in. */
function withSlot(html: string, pattern: RegExp): string {
  const replaced = html.replace(
    pattern,
    (_match, open: string) => `${open.replace(/>$/, ' data-slot="">')}</`,
  );
  if (replaced === html) throw new Error('fixture slot not found');
  return replaced;
}

function chatPage(): string {
  const user = withSlot(
    fixture('user-message.html'),
    /(<div class="text-size-chat whitespace-pre-wrap" dir="auto">)[^<]*<\//,
  );
  const reply = withSlot(
    fixture('reply.html'),
    /(<p class="TextBase-hXhSqg Text-lIMP0_" data-d-text-flow="" data-d-component="text">)[^<]*<\//,
  );
  return `<!doctype html><html><head><meta charset="utf-8"><title>ChatGPT</title></head><body>
<nav id="sidebar"><a href="/" id="new-chat">New chat</a><button type="button" id="new-chat-app">New chat (in app)</button><div id="rename"><input id="rename-input" aria-label="Chat name"><button id="rename-save" type="button">Rename</button></div><div id="convs"></div></nav>
<main id="thread"></main>
<template id="tpl-user">${user}</template>
<template id="tpl-reply">${reply}</template>
<template id="tpl-card">${fixture('reply-writing-block.html')}</template>
${fixture('composer.html')}
<script nonce="${NONCE}">${pageScript()}</script>
</body></html>`;
}

const OTHER_PAGE =
  '<!doctype html><html><head><meta charset="utf-8"><title>Elsewhere</title></head><body><p>Another site.</p></body></html>';

export async function startSite(): Promise<Site> {
  const page = chatPage();
  const { key, cert } = selfSignedCertificate([SITE_HOST, OTHER_HOST]);
  const conversations = new Map<string, StoredMessage[]>();
  const requests: RecordedRequest[] = [];
  const prompts: string[] = [];
  let handler: ReplyHandler | null = null;

  const server: Server = createServer({ key, cert }, (req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const host = (req.headers.host ?? '').replace(/:\d+$/, '');
      const body = Buffer.concat(chunks).toString('utf8');
      const method = req.method ?? 'GET';
      const path = req.url ?? '/';
      requests.push({ host, method, url: path, body, at: Date.now() });
      const json = (value: unknown): void => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(value));
      };
      if (host === OTHER_HOST) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(OTHER_PAGE);
        return;
      }
      const url = new URL(path, `https://${SITE_HOST}`);
      if (url.pathname === '/api/list') {
        json([...conversations.keys()]);
        return;
      }
      const conv = /^\/api\/conv\/([A-Za-z0-9-]+)$/.exec(url.pathname);
      if (conv?.[1]) {
        json(conversations.get(conv[1]) ?? []);
        return;
      }
      if (method === 'POST' && url.pathname === '/backend-api/f/conversation') {
        const request = JSON.parse(body) as {
          conversation_id: string | null;
          messages: { content: { parts: string[] } }[];
        };
        const text = request.messages[0]?.content.parts[0] ?? '';
        prompts.push(text);
        const id = request.conversation_id ?? randomUUID();
        const messages = conversations.get(id) ?? [];
        const reply = handler?.(text) ?? defaultReply(text);
        messages.push({ role: 'user', text }, { role: 'assistant', ...reply });
        conversations.set(id, messages);
        json({ conversation_id: id });
        return;
      }
      if (url.pathname.startsWith('/backend-api/')) {
        json({ ok: true });
        return;
      }
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'content-security-policy': `script-src 'nonce-${NONCE}' 'strict-dynamic'; object-src 'none'; base-uri 'none'`,
      });
      res.end(page);
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address() as AddressInfo;
  return {
    port,
    requests,
    prompts,
    replyWith(next) {
      handler = next;
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      }),
  };
}
