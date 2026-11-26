/**
 * The page script of the local chatgpt.com copy. `pageMain` runs in the
 * browser: the harness serves its source (`pageScript()`), so it must not
 * use anything from this module's scope.
 *
 * It behaves like ChatGPT where the extension depends on it: a composer that
 * sends with fetch, a sidebar with client-side navigation, conversations
 * stored on the server, a conversation ID shown in the URL 0.8 s after the
 * first send, replies polled from the server, and an editable writing card
 * (the sanitised ChatGPT fixture) in replies to "Draft an email to …". Each
 * card edit is saved like ChatGPT saves it: POST …/conversation/<id>/
 * writing-blocks with the card text as markdown, "@" and "_" backslash-
 * escaped and spaces between digits written as &#x20;.
 */

/** Outcome of a request made through the page's own network functions. */
export type RequestOutcome = 'sent' | 'blocked';

export interface PageRequest {
  readonly transport: 'fetch' | 'xhr' | 'beacon';
  readonly method: string;
  readonly url: string;
  readonly body: string | null;
}

/** What the harness reads and calls on `window.__pv`. */
export interface PageApi {
  /** Card saves: 'saved' or 'failed', in order. */
  readonly cardSaves: string[];
  /** Chat renames: 'saved' or 'failed', in order. */
  readonly renames: string[];
  /** Placeholder URLs (/c/local-…) the page showed, in order. */
  readonly localUrls: string[];
  /** `pageshow` events: whether the page came from the back/forward cache. */
  readonly pageshows: boolean[];
  /** Message requests the page could not send (blocked or failed). */
  failedSends: number;
  request(request: PageRequest): Promise<RequestOutcome>;
}

interface StoredMessage {
  readonly role: 'user' | 'assistant';
  readonly text: string;
  readonly card?: { readonly recipient: string; readonly text: string };
}

export function pageMain(): void {
  const editorSel = 'form[data-chatgpt-composer] [contenteditable="true"]';
  const byId = (id: string): HTMLElement => {
    const el = document.getElementById(id);
    if (!el) throw new Error(`missing #${id}`);
    return el;
  };
  const template = (id: string): HTMLTemplateElement => {
    const el = byId(id);
    if (!(el instanceof HTMLTemplateElement)) throw new Error(`#${id}`);
    return el;
  };
  const thread = byId('thread');
  const convs = byId('convs');
  /**
   * A card is saved this long after the last keystroke (ChatGPT's own delay
   * is not known; the extension's warning comes 300 ms after typing stops).
   */
  const CARD_SAVE_DELAY_MS = 1000;
  const BS = String.fromCharCode(92);
  let current: string | null = null;
  let rendered = 0;
  let syncing = false;

  const api: PageApi = {
    cardSaves: [],
    renames: [],
    localUrls: [],
    pageshows: [],
    failedSends: 0,
    request: (request) => {
      if (request.transport === 'beacon') {
        return Promise.resolve(
          navigator.sendBeacon(request.url, request.body) ? 'sent' : 'blocked',
        );
      }
      if (request.transport === 'xhr') {
        return new Promise((resolve) => {
          const xhr = new XMLHttpRequest();
          xhr.open(request.method, request.url);
          xhr.addEventListener('load', () => {
            resolve('sent');
          });
          xhr.addEventListener('error', () => {
            resolve('blocked');
          });
          xhr.send(request.body);
        });
      }
      return fetch(request.url, {
        method: request.method,
        ...(request.body === null
          ? {}
          : {
              body: request.body,
              headers: { 'content-type': 'application/json' },
            }),
      }).then(
        () => 'sent' as const,
        () => 'blocked' as const,
      );
    },
  };
  Reflect.set(window, '__pv', api);

  /** The server's conversation ID in the URL; a local placeholder is none. */
  const idFromPath = (): string | null => {
    const id = /^\/c\/([A-Za-z0-9-]+)$/.exec(location.pathname)?.[1] ?? null;
    return id === null || id.startsWith('local-') ? null : id;
  };

  /** The card text as ChatGPT's markdown serialiser writes it. */
  const markdown = (text: string): string => {
    let out = '';
    for (let i = 0; i < text.length; i += 1) {
      const c = text.charAt(i);
      const digitsAround =
        /\d/.test(text.charAt(i - 1)) && /\d/.test(text.charAt(i + 1));
      if (c === '@' || c === '_') out += BS + c;
      else if (c === ' ' && digitsAround) out += '&#x20;';
      else out += c;
    }
    return out;
  };

  const saveCard = (editor: HTMLElement, recipient: string): void => {
    if (current === null) return;
    const body = JSON.stringify({
      conversation_id: current,
      message_id: editor.dataset.messageId,
      updated_at: new Date().toISOString(),
      writing_block: {
        content: markdown(editor.textContent),
        metadata: { subject: 'Re: plan', recipient, suggested_followups: [] },
        variant: 'email',
      },
    });
    fetch(`/backend-api/conversation/${current}/writing-blocks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    }).then(
      () => api.cardSaves.push('saved'),
      () => api.cardSaves.push('failed'),
    );
  };

  const renderCard = (
    container: Element,
    card: NonNullable<StoredMessage['card']>,
    index: number,
  ): void => {
    const node = template('tpl-card').content.cloneNode(true);
    if (!(node instanceof DocumentFragment)) return;
    const editor = node.querySelector('.ProseMirror');
    if (!(editor instanceof HTMLElement)) throw new Error('card editor');
    editor.dataset.card = '';
    editor.dataset.messageId = `m-${index.toString()}`;
    editor.replaceChildren();
    const paragraph = document.createElement('p');
    paragraph.textContent = card.text;
    editor.append(paragraph);
    let timer: ReturnType<typeof setTimeout> | undefined;
    editor.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        saveCard(editor, card.recipient);
      }, CARD_SAVE_DELAY_MS);
    });
    container.append(node);
  };

  const render = (message: StoredMessage, index: number): void => {
    const tpl = template(message.role === 'user' ? 'tpl-user' : 'tpl-reply');
    const node = tpl.content.cloneNode(true);
    if (!(node instanceof DocumentFragment)) return;
    const slot = node.querySelector('[data-slot]');
    if (slot) slot.textContent = message.text;
    if (message.card) {
      const container =
        node.querySelector('[data-markdown-text-style="assistant-message"]') ??
        node.firstElementChild;
      if (container) renderCard(container, message.card, index);
    }
    thread.append(node);
  };

  const sync = async (): Promise<void> => {
    if (syncing || current === null) return;
    syncing = true;
    try {
      const id = current;
      const response = await fetch(`/api/conv/${id}`);
      const messages = (await response.json()) as StoredMessage[];
      if (id !== current) return;
      for (; rendered < messages.length; rendered += 1) {
        const message = messages[rendered];
        if (message) render(message, rendered);
      }
    } finally {
      syncing = false;
    }
  };

  const list = async (): Promise<void> => {
    const ids = (await (await fetch('/api/list')).json()) as string[];
    convs.replaceChildren();
    for (const id of ids) {
      const a = document.createElement('a');
      a.href = `/c/${id}`;
      a.textContent = id;
      a.dataset.conv = id;
      convs.append(a);
    }
  };

  const show = (): void => {
    current = idFromPath();
    rendered = 0;
    thread.replaceChildren();
    void sync();
    void list();
  };

  /**
   * ChatGPT's in-app "New chat": a fresh composer is mounted while the
   * previous one stays in the page (hidden) before it, and the first send
   * shows /c/local-chatgpt%3A<uuid> at once, before the server's ID.
   */
  let localIds = false;
  const appNewChat = (): void => {
    const forms = document.querySelectorAll('form[data-chatgpt-composer]');
    const shown = Array.from(forms).find(
      (form) => !form.hasAttribute('hidden'),
    );
    if (shown) {
      const fresh = shown.cloneNode(true);
      if (fresh instanceof HTMLFormElement) {
        const editor = fresh.querySelector('[contenteditable="true"]');
        if (editor) editor.textContent = '';
        shown.setAttribute('hidden', '');
        shown.after(fresh);
      }
    }
    localIds = true;
    history.pushState({}, '', '/');
    show();
  };

  document.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest('#new-chat-app')) {
      event.preventDefault();
      appNewChat();
      return;
    }
    const link = target?.closest('a[href]');
    if (link) {
      event.preventDefault();
      history.pushState({}, '', link.getAttribute('href'));
      show();
      return;
    }
    // Renaming the chat: PATCH …/conversation/<id> with the new title.
    if (target?.closest('#rename-save') && current !== null) {
      const input = byId('rename-input');
      const title = input instanceof HTMLInputElement ? input.value : '';
      void fetch(`/backend-api/conversation/${current}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title }),
      }).then(
        () => api.renames.push('saved'),
        () => api.renames.push('failed'),
      );
      return;
    }
    const button = target?.closest(
      'form[data-chatgpt-composer] button[type="submit"]',
    );
    if (!button) return;
    event.preventDefault();
    // The composer the button belongs to (there may be more than one).
    const editor = button
      .closest('form')
      ?.querySelector('[contenteditable="true"]');
    const text = editor?.textContent ?? '';
    if (!editor || !text.trim()) return;
    editor.textContent = '';
    const startedIn = current;
    if (startedIn === null && localIds) {
      const local = `/c/local-chatgpt%3A${crypto.randomUUID()}`;
      api.localUrls.push(local);
      history.pushState({}, '', local);
    }
    fetch('/backend-api/f/conversation', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        action: 'next',
        conversation_id: startedIn,
        messages: [
          {
            author: { role: 'user' },
            content: { content_type: 'text', parts: [text] },
          },
        ],
      }),
    })
      .then((r) => r.json() as Promise<{ conversation_id: string }>)
      .then(
        (reply) => {
          if (startedIn === null && current === null && idFromPath() === null) {
            setTimeout(() => {
              history.pushState({}, '', `/c/${reply.conversation_id}`);
              current = reply.conversation_id;
              void sync();
              void list();
            }, 800);
          } else {
            void sync();
          }
        },
        () => {
          api.failedSends += 1;
        },
      );
  });
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || event.shiftKey) return;
    if (!(event.target instanceof Element)) return;
    const editor = event.target.closest(editorSel);
    if (!editor) return;
    event.preventDefault();
    const send = editor.closest('form')?.querySelector('button[type="submit"]');
    if (send instanceof HTMLElement) send.click();
  });
  document.addEventListener('submit', (event) => {
    event.preventDefault();
  });
  addEventListener('popstate', show);
  addEventListener('pageshow', (event) => {
    api.pageshows.push(event.persisted);
  });
  setInterval(() => void sync(), 1000);
  const initialEditor = document.querySelector(editorSel);
  if (initialEditor) initialEditor.textContent = '';
  show();
}

/** The script the copy serves: `pageMain` as written, run at once. */
export function pageScript(): string {
  return `(${pageMain.toString()})();`;
}
