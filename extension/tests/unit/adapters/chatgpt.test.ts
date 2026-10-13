import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  conversationIdFromUrl,
  createChatGptAdapter,
} from '@/src/adapters/chatgpt.ts';
import { AdapterError } from '@/src/adapters/types.ts';

const streamingHtml = readFileSync(
  resolve('tests/fixtures/sites/chatgpt/composer-streaming.html'),
  'utf8',
);

const composerHtml = readFileSync(
  // Vitest runs from the extension root.
  resolve('tests/fixtures/sites/chatgpt/composer.html'),
  'utf8',
);

/** Loads a sanitised composer snapshot without innerHTML. */
function loadComposer(html = composerHtml): void {
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  document.body.replaceChildren(
    ...Array.from(parsed.body.childNodes, (node) =>
      document.importNode(node, true),
    ),
  );
}

function editorOf(): HTMLElement {
  const editor = createChatGptAdapter().getEditor();
  if (!editor) throw new Error('editor not found in fixture');
  return editor;
}

/** Replaces the editor content with ProseMirror-style paragraphs. */
function setParagraphs(editor: HTMLElement, lines: string[]): void {
  editor.replaceChildren(
    ...lines.map((line) => {
      const p = document.createElement('p');
      if (line === '') {
        const br = document.createElement('br');
        br.className = 'ProseMirror-trailingBreak';
        p.append(br);
      } else {
        p.textContent = line;
      }
      return p;
    }),
  );
}

type ExecCommand = (
  command: string,
  showUi?: boolean,
  value?: string,
) => boolean;

function stubExecCommand(impl: ExecCommand) {
  const stub = vi.fn(impl);
  Object.defineProperty(document, 'execCommand', {
    value: stub,
    configurable: true,
  });
  return stub;
}

describe('ChatGPT adapter on the composer snapshot', () => {
  beforeEach(() => {
    loadComposer();
  });

  afterEach(() => {
    Reflect.deleteProperty(document, 'execCommand');
  });

  it('finds the ProseMirror editor', () => {
    const editor = editorOf();
    expect(editor.getAttribute('contenteditable')).toBe('true');
    expect(editor.getAttribute('role')).toBe('textbox');
    expect(editor.classList.contains('ProseMirror')).toBe(true);
  });

  it('finds the submit button, not the other composer buttons', () => {
    const button = createChatGptAdapter().getSendButton();
    expect(button?.getAttribute('type')).toBe('submit');
    expect(button?.getAttribute('aria-label')).toBe('Send');
  });

  it('reads the prompt text from the snapshot', () => {
    expect(createChatGptAdapter().readPrompt()).toBe('Draft prompt');
  });

  it('reads paragraphs as lines and keeps blank lines', () => {
    setParagraphs(editorOf(), ['first', '', 'third']);
    expect(createChatGptAdapter().readPrompt()).toBe('first\n\nthird');
  });

  it('reads hard breaks as newlines and ignores the trailing break', () => {
    const editor = editorOf();
    const p = document.createElement('p');
    const trailing = document.createElement('br');
    trailing.className = 'ProseMirror-trailingBreak';
    p.append('a', document.createElement('br'), 'b', trailing);
    editor.replaceChildren(p);
    expect(createChatGptAdapter().readPrompt()).toBe('a\nb');
  });

  it('reads an empty editor as an empty prompt', () => {
    setParagraphs(editorOf(), ['']);
    expect(createChatGptAdapter().readPrompt()).toBe('');
  });

  it('reads non-breaking spaces as spaces', () => {
    setParagraphs(editorOf(), ['a\xA0 b']);
    expect(createChatGptAdapter().readPrompt()).toBe('a  b');
  });

  it('reads nested blocks one line each', () => {
    const editor = editorOf();
    const list = document.createElement('ul');
    for (const text of ['one', 'two']) {
      const li = document.createElement('li');
      const p = document.createElement('p');
      p.textContent = text;
      li.append(p);
      list.append(li);
    }
    const after = document.createElement('p');
    after.textContent = 'after';
    editor.replaceChildren(list, after);
    expect(createChatGptAdapter().readPrompt()).toBe('one\ntwo\nafter');
  });

  it('writes through insertText on a full selection and resolves on a match', async () => {
    const editor = editorOf();
    const exec = stubExecCommand((command, _ui, value) => {
      // Behave like the editor: one paragraph per line.
      if (command === 'insertText' && value !== undefined) {
        setParagraphs(editor, value.split('\n'));
      }
      return true;
    });
    await createChatGptAdapter().writePrompt('line 1\n\nline 3');
    expect(exec).toHaveBeenCalledWith('insertText', false, 'line 1\n\nline 3');
    expect(createChatGptAdapter().readPrompt()).toBe('line 1\n\nline 3');
    expect(document.activeElement).toBe(editor);
  });

  it('normalises CRLF line endings before writing', async () => {
    const editor = editorOf();
    const exec = stubExecCommand((_command, _ui, value) => {
      setParagraphs(editor, (value ?? '').split('\n'));
      return true;
    });
    await createChatGptAdapter().writePrompt('a\r\nb');
    expect(exec).toHaveBeenCalledWith('insertText', false, 'a\nb');
  });

  it('clears the editor with delete for an empty prompt', async () => {
    const editor = editorOf();
    const exec = stubExecCommand(() => {
      setParagraphs(editor, ['']);
      return true;
    });
    await createChatGptAdapter().writePrompt('');
    expect(exec).toHaveBeenCalledWith('delete');
  });

  it('rejects when the editor does not reflect the written text', async () => {
    stubExecCommand(() => true);
    await expect(
      createChatGptAdapter().writePrompt('something else'),
    ).rejects.toMatchObject({ code: 'write-mismatch' });
  });

  it('rejects when the browser refuses the edit', async () => {
    stubExecCommand(() => false);
    await expect(
      createChatGptAdapter().writePrompt('x'),
    ).rejects.toBeInstanceOf(AdapterError);
  });

  it('clicks the send button on triggerSend', () => {
    const adapter = createChatGptAdapter();
    const onClick = vi.fn((event: Event) => {
      event.preventDefault();
    });
    adapter.getSendButton()?.addEventListener('click', onClick);
    adapter.triggerSend();
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('refuses to send through a disabled button', () => {
    const adapter = createChatGptAdapter();
    const button = adapter.getSendButton();
    if (!(button instanceof HTMLButtonElement)) throw new Error('no button');
    button.disabled = true;
    expect(() => {
      adapter.triggerSend();
    }).toThrow(AdapterError);
    button.disabled = false;
    button.setAttribute('aria-disabled', 'true');
    expect(() => {
      adapter.triggerSend();
    }).toThrow(AdapterError);
  });

  it('refuses a send button in its stop state', () => {
    const adapter = createChatGptAdapter();
    const button = adapter.getSendButton();
    if (!button) throw new Error('no button');
    button.dataset.testid = 'stop-button';
    const onClick = vi.fn();
    button.addEventListener('click', onClick);
    expect(() => {
      adapter.triggerSend();
    }).toThrow(expect.objectContaining({ code: 'send-button-stop' }));
    expect(onClick).not.toHaveBeenCalled();
  });

  it('reads a long multi-paragraph prompt quickly', () => {
    const lines = Array.from(
      { length: 2000 },
      (_, i) => `Paragraph ${i.toString()} ${'x'.repeat(45)}`,
    );
    setParagraphs(editorOf(), lines);
    const adapter = createChatGptAdapter();
    const startedAt = performance.now();
    const text = adapter.readPrompt();
    // jsdom is far slower than Chrome; this budget catches super-linear
    // behaviour, which would take seconds at this size.
    expect(performance.now() - startedAt).toBeLessThan(1000);
    expect(text.length).toBeGreaterThan(100_000);
  });

  it('marks message methods as not implemented yet', () => {
    const adapter = createChatGptAdapter();
    expect(() => adapter.getMessageContainers()).toThrow(AdapterError);
    expect(() => adapter.isAssistantMessage(document.body)).toThrow(
      AdapterError,
    );
  });
});

describe('ChatGPT adapter while a reply is streaming', () => {
  beforeEach(() => {
    loadComposer(streamingHtml);
  });

  it('finds the editor and its text', () => {
    expect(createChatGptAdapter().readPrompt()).toBe('Draft prompt');
  });

  it('targets the Send button, which queues the message', () => {
    const adapter = createChatGptAdapter();
    const button = adapter.getSendButton();
    expect(button?.getAttribute('type')).toBe('submit');
    expect(button?.getAttribute('aria-label')).toBe('Send');
    const onClick = vi.fn((event: Event) => {
      event.preventDefault();
    });
    button?.addEventListener('click', onClick);
    adapter.triggerSend();
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('has no stop-state button inside the composer form', () => {
    const form = document.querySelector('form[data-chatgpt-composer]');
    expect(form?.querySelectorAll('button[type="submit"]')).toHaveLength(1);
    expect(form?.querySelector('[data-testid="stop-button"]')).toBeNull();
  });
});

describe('ChatGPT adapter without a composer', () => {
  beforeEach(() => {
    document.body.replaceChildren();
  });

  it('reports missing elements', async () => {
    const adapter = createChatGptAdapter();
    expect(adapter.getEditor()).toBeNull();
    expect(adapter.getSendButton()).toBeNull();
    expect(() => adapter.readPrompt()).toThrow(AdapterError);
    expect(() => {
      adapter.triggerSend();
    }).toThrow(AdapterError);
    await expect(adapter.writePrompt('x')).rejects.toMatchObject({
      code: 'editor-missing',
    });
  });

  it('falls back to the earlier #prompt-textarea editor', () => {
    const legacy = document.createElement('div');
    legacy.id = 'prompt-textarea';
    legacy.contentEditable = 'true';
    document.body.append(legacy);
    expect(createChatGptAdapter().getEditor()).toBe(legacy);
  });

  it('falls back to the earlier send-button test id', () => {
    const button = document.createElement('button');
    button.dataset.testid = 'send-button';
    document.body.append(button);
    expect(createChatGptAdapter().getSendButton()).toBe(button);
  });
});

describe('ChatGPT URLs', () => {
  const adapter = createChatGptAdapter();

  it('matches chatgpt.com only', () => {
    expect(adapter.matches(new URL('https://chatgpt.com/'))).toBe(true);
    expect(adapter.matches(new URL('https://chatgpt.com/c/abc'))).toBe(true);
    expect(adapter.matches(new URL('https://example.com/'))).toBe(false);
    expect(adapter.matches(new URL('https://chatgpt.com.example.com/'))).toBe(
      false,
    );
  });

  it.each([
    [
      'https://chatgpt.com/c/6710a1b2-0c3d-8000-9e4f-123456789abc',
      '6710a1b2-0c3d-8000-9e4f-123456789abc',
    ],
    [
      'https://chatgpt.com/g/g-p-abc123-project/c/6710a1b2-0c3d-8000-9e4f-123456789abc',
      '6710a1b2-0c3d-8000-9e4f-123456789abc',
    ],
    ['https://chatgpt.com/c/6710a1b2-0c3d?model=x', '6710a1b2-0c3d'],
    ['https://chatgpt.com/', null],
    ['https://chatgpt.com/?model=gpt', null],
    ['https://chatgpt.com/g/g-abc123-some-gpt', null],
    ['https://chatgpt.com/share/6710a1b2-0c3d-8000', null],
    ['https://chatgpt.com/c/', null],
  ])('%s → %s', (url, expected) => {
    expect(conversationIdFromUrl(new URL(url))).toBe(expected);
  });

  it('reads the conversation id from the current location', () => {
    expect(adapter.getConversationId()).toBeNull();
  });
});
