import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from 'vitest';
import { createChatGptAdapter } from '@/src/adapters/chatgpt.ts';
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

const source: StandInSource = { version: 1, mappings: () => [DANA] };

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

const QUIET_MS = 40;

function query(selector: string): HTMLElement {
  const el = document.querySelector<HTMLElement>(selector);
  if (!el) throw new Error(`missing ${selector}`);
  return el;
}

/** Records every mutation inside `el` (text, attributes, nodes). */
function watch(el: Element): MutationRecord[] {
  const records: MutationRecord[] = [];
  new MutationObserver((batch) => {
    records.push(...batch);
  }).observe(el, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
  });
  return records;
}

describe('restorer: protected surfaces', () => {
  let controller: AbortController;
  let info: MockInstance<(...data: unknown[]) => void>;

  beforeEach(() => {
    controller = new AbortController();
    info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
  });

  afterEach(() => {
    controller.abort();
    vi.restoreAllMocks();
  });

  const start = (): void => {
    startRestorer({
      adapter: createChatGptAdapter(),
      source,
      signal: controller.signal,
      quietMs: QUIET_MS,
    });
  };

  const protectedReports = (): string[] =>
    info.mock.calls
      .map((call) => String(call[0]))
      .filter((line) => line.includes('restore.protected'));

  it('never rewrites a Writing card (ProseMirror) reply, text or mailto link', async () => {
    load(fixture('reply-writing-block.html'));
    const editor = query('.writing-block-editor .ProseMirror');
    const before = editor.cloneNode(true);
    const records = watch(editor);
    start();
    await settle();
    await wait(QUIET_MS * 2);
    await settle();
    expect(records).toEqual([]);
    expect(editor.isEqualNode(before)).toBe(true);
    expect(query('.ProseMirror a').getAttribute('href')).toBe(
      'mailto:standin.1@example.net',
    );
    // Counted as protected, not as a leak, with a count only.
    expect(protectedReports()).toEqual([
      expect.stringMatching(/restore\.protected count=2$/) as string,
    ]);
  });

  it('keeps a read-only editor view protected too', async () => {
    load(fixture('reply-writing-block.html'));
    const editor = query('.ProseMirror');
    editor.setAttribute('contenteditable', 'false');
    const records = watch(editor);
    start();
    await settle();
    expect(records).toEqual([]);
    expect(editor.textContent).toContain('standin.1@example.net');
  });

  it('leaves a mailto link inside an editable surface of a watched reply as the stand-in', async () => {
    // Regression: links were rewritten even inside editable subtrees.
    load(fixture('reply.html'));
    const reply = query('[data-markdown-text-style="assistant-message"]');
    const editable = document.createElement('div');
    editable.setAttribute('contenteditable', 'true');
    const link = document.createElement('a');
    link.setAttribute('href', 'mailto:standin.1@example.net');
    link.textContent = 'standin.1@example.net';
    editable.append(link);
    const normal = document.createElement('p');
    normal.textContent = 'Mail standin.1@example.net soon.';
    reply.append(normal, editable);

    start();
    await settle();
    expect(link.getAttribute('href')).toBe('mailto:standin.1@example.net');
    expect(link.textContent).toBe('standin.1@example.net');
    expect(normal.textContent).toBe('Mail dana@example.com soon.');
  });

  it('restores a normal reply next to a Writing card and leaves the card alone', async () => {
    load(`${fixture('reply.html')}${fixture('reply-writing-block.html')}`);
    const reply = query('[data-markdown-text-style="assistant-message"]');
    const p = document.createElement('p');
    const link = document.createElement('a');
    link.setAttribute('href', 'mailto:standin.1@example.net');
    link.textContent = 'standin.1@example.net';
    p.append('Write to ', link);
    reply.append(p);
    const card = query('.ProseMirror');
    const before = card.cloneNode(true);

    start();
    await settle();
    expect(p.textContent).toBe('Write to dana@example.com');
    expect(link.getAttribute('href')).toBe('mailto:dana@example.com');
    expect(card.isEqualNode(before)).toBe(true);
  });

  it('reports a surface once per change of its count, not on every streamed mutation', async () => {
    load(fixture('reply-writing-block.html'));
    start();
    await settle();
    await wait(QUIET_MS * 2);
    await settle();
    const editor = query('.ProseMirror');
    // The card streams more text: several mutations, one more stand-in.
    for (const word of ['More ', 'from ', 'standin.1@example.net', ' today.']) {
      const span = document.createElement('span');
      span.textContent = word;
      editor.lastElementChild?.append(span);
      await settle();
    }
    await wait(QUIET_MS * 2);
    await settle();
    // Unchanged text afterwards: no new report.
    editor.lastElementChild?.append(document.createElement('span'));
    await wait(QUIET_MS * 2);
    await settle();
    const reports = protectedReports();
    expect(reports).toHaveLength(2);
    expect(reports[0]).toMatch(/count=2$/);
    expect(reports[1]).toMatch(/count=3$/);
    expect(editor.textContent).toContain('from standin.1@example.net today.');
  });
});
