import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createChatGptAdapter } from '@/src/adapters/chatgpt.ts';
import type { SiteAdapter } from '@/src/adapters/types.ts';
import { startRestorer } from '@/src/content/restorer.ts';
import type {
  StandInMapping,
  StandInSource,
} from '@/src/core/restore/index.ts';

const fixture = (name: string): string =>
  readFileSync(resolve(`tests/fixtures/sites/chatgpt/${name}`), 'utf8');

function load(html: string): void {
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  document.body.replaceChildren(
    ...Array.from(parsed.body.childNodes, (node) =>
      document.importNode(node, true),
    ),
  );
}

const DANA: StandInMapping = {
  standIn: 'standin.1@example.net',
  real: 'dana@example.com',
  boundary: 'email',
};
const OPS: StandInMapping = {
  standIn: 'standin.2@example.net',
  real: 'ops@example.org',
  boundary: 'email',
};

function mutableSource(initial: StandInMapping[]) {
  let mappings = initial;
  let version = 1;
  const source: StandInSource = {
    get version() {
      return version;
    },
    mappings: () => mappings,
  };
  return {
    source,
    add(mapping: StandInMapping) {
      mappings = [...mappings, mapping];
      version += 1;
    },
  };
}

/** Lets the observer run and the scheduled animation frame complete. */
async function settle(): Promise<void> {
  await Promise.resolve();
  await new Promise<void>((done) => {
    requestAnimationFrame(() => {
      done();
    });
  });
}

const wait = (ms: number): Promise<void> =>
  new Promise((done) => {
    setTimeout(done, ms);
  });

/** Tag structure of an element, to prove no elements were added or removed. */
const shape = (el: Element): string =>
  Array.from(el.querySelectorAll('*'), (child) => child.tagName).join(',');

const QUIET_MS = 40;

function assistantContent(): HTMLElement {
  const el = document.querySelector<HTMLElement>(
    '[data-markdown-text-style="assistant-message"]',
  );
  if (!el) throw new Error('no assistant message');
  return el;
}

function wordSpan(text: string): HTMLSpanElement {
  const span = document.createElement('span');
  span.dataset.dTextFlow = 'word';
  span.dataset.dStreamWord = '';
  span.textContent = text;
  return span;
}

describe('startRestorer', () => {
  let controller: AbortController;
  let adapter: SiteAdapter;

  beforeEach(() => {
    controller = new AbortController();
    adapter = createChatGptAdapter();
    load(fixture('conversation.html'));
  });

  afterEach(() => {
    controller.abort();
    vi.restoreAllMocks();
  });

  const start = (
    source: StandInSource,
    overrides: Partial<SiteAdapter> = {},
  ): void => {
    startRestorer({
      adapter: { ...adapter, ...overrides },
      source,
      signal: controller.signal,
      quietMs: QUIET_MS,
    });
  };

  it('restores existing user and assistant messages on start', async () => {
    const assistant = assistantContent();
    const before = shape(assistant);
    start(mutableSource([DANA, OPS]).source);
    await settle();

    const user = document.querySelector('[data-user-message-bubble]');
    expect(user?.textContent).toContain(
      'Please write to dana@example.com today',
    );
    const paragraphs = Array.from(
      assistant.querySelectorAll('p'),
      (p) => p.textContent,
    );
    expect(paragraphs).toEqual([
      'Please contact dana@example.com today.',
      'Also ops@example.org works.',
      'Bold: dana@example.com done.',
    ]);
    expect(shape(assistant)).toBe(before);
  });

  it('rewrites a stand-in split across word spans in place', async () => {
    start(mutableSource([OPS]).source);
    await settle();
    const spans = Array.from(
      assistantContent().querySelectorAll('p')[1]?.querySelectorAll('span') ??
        [],
      (s) => s.textContent,
    );
    expect(spans).toEqual(['Also ', 'ops@example.org', ' ', 'works.']);
  });

  it('rewrites a stand-in split by formatting without touching the markup', async () => {
    start(mutableSource([DANA]).source);
    await settle();
    const bold = assistantContent().querySelector('strong');
    expect(bold?.textContent).toBe('dana@example.com');
    expect(bold?.querySelector('span')).not.toBeNull();
  });

  it('restores text the page writes back', async () => {
    start(mutableSource([DANA]).source);
    await settle();
    const word = assistantContent().querySelectorAll('span')[2];
    const text = word?.firstChild;
    if (!(text instanceof Text)) throw new Error('no word text');
    expect(text.nodeValue).toBe('dana@example.com ');

    // A re-render writes the stand-in back into the same node.
    text.nodeValue = 'standin.1@example.net ';
    await settle();
    expect(text.nodeValue).toBe('dana@example.com ');
  });

  it('does not react to its own writes', async () => {
    const frames = vi.spyOn(window, 'requestAnimationFrame');
    start(mutableSource([DANA, OPS]).source);
    await settle();
    const after = frames.mock.calls.length;
    await settle();
    await settle();
    // Only the two frames requested by settle() itself.
    expect(frames.mock.calls.length).toBe(after + 2);
  });

  it('restores a reply while it streams and after it settles', async () => {
    const source = mutableSource([DANA]);
    start(source.source);
    await settle();

    const p = document.createElement('p');
    p.dataset.dComponent = 'text';
    assistantContent().append(p);
    p.append(wordSpan('Reach '));
    await settle();

    // The next word arrives in pieces.
    const word = wordSpan('standin.1@exa');
    p.append(word);
    await settle();
    expect(p.textContent).toBe('Reach standin.1@exa');

    const text = word.firstChild;
    if (!(text instanceof Text)) throw new Error('no text');
    text.nodeValue = 'standin.1@example.net';
    await settle();
    // Still the last word of a streaming reply: held back.
    expect(p.textContent).toBe('Reach standin.1@example.net');

    text.nodeValue = 'standin.1@example.net ';
    p.append(wordSpan('now.'));
    await settle();
    expect(p.textContent).toBe('Reach dana@example.com now.');
  });

  it('restores a stand-in at the very end once the reply is quiet', async () => {
    start(mutableSource([DANA]).source);
    await settle();
    const p = document.createElement('p');
    assistantContent().append(p);
    p.append(wordSpan('Mail '), wordSpan('standin.1@example.net'));
    await settle();
    expect(p.textContent).toBe('Mail standin.1@example.net');
    await wait(QUIET_MS * 3);
    await settle();
    expect(p.textContent).toBe('Mail dana@example.com');
  });

  it('uses the adapter completion signal when there is one', async () => {
    start(mutableSource([DANA]).source, { isReplyComplete: () => true });
    await settle();
    const p = document.createElement('p');
    assistantContent().append(p);
    p.append(wordSpan('Mail '), wordSpan('standin.1@example.net'));
    await settle();
    expect(p.textContent).toBe('Mail dana@example.com');
  });

  it('applies mappings added after the text appeared', async () => {
    const source = mutableSource([]);
    start(source.source);
    await settle();
    expect(assistantContent().textContent).toContain('standin.1@example.net');
    source.add(DANA);
    // Any later mutation picks up the new version.
    assistantContent().append(wordSpan(' '));
    await settle();
    expect(assistantContent().textContent).not.toContain(
      'standin.1@example.net',
    );
  });

  it('never touches the composer or editable areas', async () => {
    load(`${fixture('composer.html')}${fixture('conversation.html')}`);
    const editor = adapter.getMainComposer()?.getEditor();
    const paragraph = editor?.querySelector('p');
    if (!paragraph) throw new Error('no editor paragraph');
    paragraph.textContent = 'standin.1@example.net';

    const user = document.querySelector('[data-user-message-bubble]');
    const editBox = document.createElement('textarea');
    editBox.textContent = 'standin.1@example.net';
    const editable = document.createElement('div');
    // jsdom does not reflect the contentEditable property; Chrome does.
    editable.setAttribute('contenteditable', 'true');
    editable.textContent = 'standin.1@example.net';
    user?.append(editBox, editable);

    start(mutableSource([DANA]).source);
    await settle();
    paragraph.append(' more');
    await settle();

    expect(paragraph.textContent).toBe('standin.1@example.net more');
    expect(editBox.textContent).toBe('standin.1@example.net');
    expect(editable.textContent).toBe('standin.1@example.net');
    expect(user?.textContent).toContain(
      'Please write to dana@example.com today',
    );
  });

  it('restores the address of a mailto link', async () => {
    const link = document.createElement('a');
    link.href = 'mailto:standin.1@example.net?subject=Hi';
    link.textContent = 'standin.1@example.net';
    const p = document.createElement('p');
    p.append(link, ' ok');
    assistantContent().append(p);

    start(mutableSource([DANA]).source);
    await settle();
    expect(link.getAttribute('href')).toBe(
      'mailto:dana@example.com?subject=Hi',
    );
    expect(link.textContent).toBe('dana@example.com');

    // The page resets the attribute; it is restored again.
    link.setAttribute('href', 'mailto:standin.1@example.net');
    await settle();
    expect(link.getAttribute('href')).toBe('mailto:dana@example.com');
  });

  it('logs only a count in the leak check after a reply settles', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    start(mutableSource([DANA]).source);
    await settle();
    const p = document.createElement('p');
    assistantContent().append(p);
    p.append(
      wordSpan('Odd '),
      wordSpan('xstandin.1@example.net.au '),
      wordSpan('end.'),
    );
    await wait(QUIET_MS * 3);
    await settle();

    const lines = info.mock.calls.map((call) => String(call[0]));
    const leak = lines.filter((line) => line.includes('restore.leak-check'));
    expect(leak.at(-1)).toMatch(/count=1$/);
    for (const line of lines) expect(line).not.toContain('@');
  });

  it('stops restoring when aborted', async () => {
    start(mutableSource([DANA]).source);
    await settle();
    controller.abort();
    const p = document.createElement('p');
    p.append(wordSpan('standin.1@example.net '), wordSpan('later'));
    assistantContent().append(p);
    await settle();
    await wait(QUIET_MS * 3);
    expect(p.textContent).toBe('standin.1@example.net later');
  });

  it('catches up on a 200-message conversation with linear work', async () => {
    const main = document.createElement('main');
    const content = assistantContent().cloneNode(true);
    const user = document
      .querySelector('[data-user-message-bubble]')
      ?.cloneNode(true);
    if (!user) throw new Error('no user bubble');
    for (let i = 0; i < 100; i += 1) {
      main.append(user.cloneNode(true), content.cloneNode(true));
    }
    document.body.replaceChildren(main);
    expect(adapter.getMessageContainers()).toHaveLength(200);

    // Count the work instead of timing it, so the check does not depend on
    // machine load: catch-up must look at each message about once.
    let lookups = 0;
    const startedAt = performance.now();
    start(mutableSource([DANA, OPS]).source, {
      getMessageContainer: (node) => {
        lookups += 1;
        return adapter.getMessageContainer(node);
      },
    });
    await settle();
    expect(main.textContent).not.toContain('standin.');
    expect(lookups).toBeLessThanOrEqual(400);
    // A gross backstop only; jsdom under load is far slower than Chrome.
    expect(performance.now() - startedAt).toBeLessThan(15_000);
    // jsdom needs 4–5 s for this on the target laptop, close to the default
    // 5 s limit; the test's own limits are the lookup count and the backstop.
  }, 20_000);

  it('leaves the edit-message box alone', async () => {
    load(`${fixture('conversation.html')}${fixture('edit-box.html')}`);
    const editor = document.querySelector('form [role="textbox"]');
    start(mutableSource([DANA]).source);
    await settle();
    editor?.append(' more');
    await settle();
    expect(editor?.textContent).toBe(
      'Please reply to standin.1@example.net about the plan more',
    );
    expect(assistantContent().textContent).toContain('dana@example.com');
  });
});
