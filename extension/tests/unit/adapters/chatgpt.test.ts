import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  chatgptNetRules,
  conversationIdFromUrl,
  createChatGptAdapter,
} from '@/src/adapters/chatgpt.ts';
import { sendEventComposer } from '@/src/content/send-events.ts';
import { AdapterError, type Composer } from '@/src/adapters/types.ts';

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

/** The main composer of a freshly created adapter. */
function mainComposer(): Composer {
  const composer = createChatGptAdapter().getMainComposer();
  if (!composer) throw new Error('main composer not found');
  return composer;
}

function editorOf(): HTMLElement {
  const editor = mainComposer().getEditor();
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
    const button = mainComposer().getSendButton();
    expect(button?.getAttribute('type')).toBe('submit');
    expect(button?.getAttribute('aria-label')).toBe('Send');
  });

  it('reads the prompt text from the snapshot', () => {
    expect(mainComposer().readPrompt()).toBe('Draft prompt');
  });

  it('reads paragraphs as lines and keeps blank lines', () => {
    setParagraphs(editorOf(), ['first', '', 'third']);
    expect(mainComposer().readPrompt()).toBe('first\n\nthird');
  });

  it('reads hard breaks as newlines and ignores the trailing break', () => {
    const editor = editorOf();
    const p = document.createElement('p');
    const trailing = document.createElement('br');
    trailing.className = 'ProseMirror-trailingBreak';
    p.append('a', document.createElement('br'), 'b', trailing);
    editor.replaceChildren(p);
    expect(mainComposer().readPrompt()).toBe('a\nb');
  });

  it('reads an empty editor as an empty prompt', () => {
    setParagraphs(editorOf(), ['']);
    expect(mainComposer().readPrompt()).toBe('');
  });

  it('reads non-breaking spaces as spaces', () => {
    setParagraphs(editorOf(), ['a\xA0 b']);
    expect(mainComposer().readPrompt()).toBe('a  b');
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
    expect(mainComposer().readPrompt()).toBe('one\ntwo\nafter');
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
    await mainComposer().writePrompt('line 1\n\nline 3');
    expect(exec).toHaveBeenCalledWith('insertText', false, 'line 1\n\nline 3');
    expect(mainComposer().readPrompt()).toBe('line 1\n\nline 3');
    expect(document.activeElement).toBe(editor);
  });

  it('normalises CRLF line endings before writing', async () => {
    const editor = editorOf();
    const exec = stubExecCommand((_command, _ui, value) => {
      setParagraphs(editor, (value ?? '').split('\n'));
      return true;
    });
    await mainComposer().writePrompt('a\r\nb');
    expect(exec).toHaveBeenCalledWith('insertText', false, 'a\nb');
  });

  it('clears the editor with delete for an empty prompt', async () => {
    const editor = editorOf();
    const exec = stubExecCommand(() => {
      setParagraphs(editor, ['']);
      return true;
    });
    await mainComposer().writePrompt('');
    expect(exec).toHaveBeenCalledWith('delete');
  });

  it('rejects when the editor does not reflect the written text', async () => {
    stubExecCommand(() => true);
    await expect(
      mainComposer().writePrompt('something else'),
    ).rejects.toMatchObject({ code: 'write-mismatch' });
  });

  it('rejects when the browser refuses the edit', async () => {
    stubExecCommand(() => false);
    await expect(mainComposer().writePrompt('x')).rejects.toBeInstanceOf(
      AdapterError,
    );
  });

  it('clicks the send button on triggerSend', () => {
    const composer = mainComposer();
    const onClick = vi.fn((event: Event) => {
      event.preventDefault();
    });
    composer.getSendButton()?.addEventListener('click', onClick);
    composer.triggerSend();
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('refuses to send through a disabled button', () => {
    const composer = mainComposer();
    const button = composer.getSendButton();
    if (!(button instanceof HTMLButtonElement)) throw new Error('no button');
    button.disabled = true;
    expect(() => {
      composer.triggerSend();
    }).toThrow(AdapterError);
    button.disabled = false;
    button.setAttribute('aria-disabled', 'true');
    expect(() => {
      composer.triggerSend();
    }).toThrow(AdapterError);
  });

  it('refuses a send button in its stop state', () => {
    const composer = mainComposer();
    const button = composer.getSendButton();
    if (!button) throw new Error('no button');
    button.dataset.testid = 'stop-button';
    const onClick = vi.fn();
    button.addEventListener('click', onClick);
    expect(() => {
      composer.triggerSend();
    }).toThrow(expect.objectContaining({ code: 'send-button-stop' }));
    expect(onClick).not.toHaveBeenCalled();
  });

  it('reads a long multi-paragraph prompt quickly', () => {
    const lines = Array.from(
      { length: 2000 },
      (_, i) => `Paragraph ${i.toString()} ${'x'.repeat(45)}`,
    );
    setParagraphs(editorOf(), lines);
    const composer = mainComposer();
    const startedAt = performance.now();
    const text = composer.readPrompt();
    // jsdom is far slower than Chrome; this budget catches super-linear
    // behaviour, which would take seconds at this size.
    expect(performance.now() - startedAt).toBeLessThan(1000);
    expect(text.length).toBeGreaterThan(100_000);
  });
});

describe('ChatGPT messages', () => {
  const conversationHtml = readFileSync(
    resolve('tests/fixtures/sites/chatgpt/conversation.html'),
    'utf8',
  );

  beforeEach(() => {
    loadComposer(conversationHtml);
  });

  it('finds the user bubble and the assistant reply in order', () => {
    const adapter = createChatGptAdapter();
    const containers = adapter.getMessageContainers();
    expect(containers).toHaveLength(2);
    const [user, assistant] = containers;
    expect(user?.dataset.userMessageBubble).toBe('true');
    expect(assistant?.dataset.markdownTextStyle).toBe('assistant-message');
    expect(user && adapter.isAssistantMessage(user)).toBe(false);
    expect(assistant && adapter.isAssistantMessage(assistant)).toBe(true);
  });

  it('maps a streamed word to its outermost message container', () => {
    const adapter = createChatGptAdapter();
    const word = document.querySelector('[data-d-stream-word]');
    const text = word?.firstChild;
    if (!text) throw new Error('no word span');
    const container = adapter.getMessageContainer(text);
    expect(container?.dataset.markdownTextStyle).toBe('assistant-message');
  });

  it('returns null outside messages', () => {
    const adapter = createChatGptAdapter();
    expect(adapter.getMessageContainer(document.body)).toBeNull();
    const heading = document.querySelector('h4');
    expect(heading && adapter.getMessageContainer(heading)).toBeNull();
  });

  it('limits containers to a subtree', () => {
    const adapter = createChatGptAdapter();
    const turn = document.querySelector(
      '[data-chatgpt-search-unit-key$=":user"]',
    );
    if (!turn) throw new Error('no user turn');
    const inside = adapter.getMessageContainers(turn);
    expect(inside).toHaveLength(1);
    expect(inside[0]?.dataset.userMessageBubble).toBe('true');
  });

  it('does not treat the composer as a message', () => {
    loadComposer();
    const adapter = createChatGptAdapter();
    const editor = adapter.getMainComposer()?.getEditor();
    if (!editor) throw new Error('no editor');
    expect(adapter.getMessageContainer(editor)).toBeNull();
    expect(adapter.getMessageContainers()).toEqual([]);
  });

  it('finds the reply in the single reply snapshots', () => {
    for (const file of ['reply.html', 'reply-word-spans.html']) {
      loadComposer(
        readFileSync(resolve(`tests/fixtures/sites/chatgpt/${file}`), 'utf8'),
      );
      const adapter = createChatGptAdapter();
      const containers = adapter.getMessageContainers();
      expect(containers).toHaveLength(1);
      expect(containers[0] && adapter.isAssistantMessage(containers[0])).toBe(
        true,
      );
    }
  });

  it('finds the user bubble snapshot', () => {
    loadComposer(
      readFileSync(
        resolve('tests/fixtures/sites/chatgpt/user-message.html'),
        'utf8',
      ),
    );
    const adapter = createChatGptAdapter();
    const [user] = adapter.getMessageContainers();
    expect(user?.textContent).toContain('standin.1@example.net');
    expect(user && adapter.isAssistantMessage(user)).toBe(false);
  });

  it('falls back to the earlier author-role markers', () => {
    const user = document.createElement('div');
    user.dataset.messageAuthorRole = 'user';
    const assistant = document.createElement('div');
    assistant.dataset.messageAuthorRole = 'assistant';
    document.body.replaceChildren(user, assistant);
    const adapter = createChatGptAdapter();
    expect(adapter.getMessageContainers()).toEqual([user, assistant]);
    expect(adapter.isAssistantMessage(assistant)).toBe(true);
    expect(adapter.isAssistantMessage(user)).toBe(false);
  });
});

describe('ChatGPT adapter while a reply is streaming', () => {
  beforeEach(() => {
    loadComposer(streamingHtml);
  });

  it('finds the editor and its text', () => {
    expect(mainComposer().readPrompt()).toBe('Draft prompt');
  });

  it('targets the Send button, which queues the message', () => {
    const composer = mainComposer();
    const button = composer.getSendButton();
    expect(button?.getAttribute('type')).toBe('submit');
    expect(button?.getAttribute('aria-label')).toBe('Send');
    const onClick = vi.fn((event: Event) => {
      event.preventDefault();
    });
    button?.addEventListener('click', onClick);
    composer.triggerSend();
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

  it('has no main composer and fails closed if one disappears', async () => {
    expect(createChatGptAdapter().getMainComposer()).toBeNull();

    loadComposer();
    const composer = mainComposer();
    document.body.replaceChildren();
    expect(composer.getEditor()).toBeNull();
    expect(composer.getSendButton()).toBeNull();
    expect(() => composer.readPrompt()).toThrow(AdapterError);
    expect(() => {
      composer.triggerSend();
    }).toThrow(AdapterError);
    await expect(composer.writePrompt('x')).rejects.toMatchObject({
      code: 'editor-missing',
    });
  });

  it('falls back to the earlier #prompt-textarea editor', () => {
    const legacy = document.createElement('div');
    legacy.id = 'prompt-textarea';
    legacy.contentEditable = 'true';
    document.body.append(legacy);
    expect(mainComposer().getEditor()).toBe(legacy);
  });

  it('falls back to the earlier send-button test id', () => {
    const legacy = document.createElement('div');
    legacy.id = 'prompt-textarea';
    const button = document.createElement('button');
    button.dataset.testid = 'send-button';
    document.body.append(legacy, button);
    expect(mainComposer().getSendButton()).toBe(button);
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

describe('ChatGPT edit-message box', () => {
  const editBoxHtml = readFileSync(
    resolve('tests/fixtures/sites/chatgpt/edit-box.html'),
    'utf8',
  );

  /** The edit box open in the thread, with the main composer below it. */
  function loadEditAndComposer(): void {
    loadComposer(`${editBoxHtml}${composerHtml}`);
  }

  function editElements() {
    const form = document.querySelector('form:not([data-chatgpt-composer])');
    const editor = form?.querySelector<HTMLElement>('[role="textbox"]');
    const send = form?.querySelector<HTMLElement>('button[type="submit"]');
    const cancel = form?.querySelector<HTMLElement>('button[type="button"]');
    if (!form || !editor || !send || !cancel) {
      throw new Error('edit box not found in fixture');
    }
    return { form, editor, send, cancel };
  }

  beforeEach(loadEditAndComposer);

  it('resolves the edit box from its editor, its Send button and its form', () => {
    const adapter = createChatGptAdapter();
    const { form, editor, send } = editElements();
    for (const target of [editor, editor.firstChild, send, form]) {
      const composer = adapter.composerFor(target);
      expect(composer?.kind).toBe('edit');
      expect(composer?.getEditor()).toBe(editor);
    }
  });

  it('reads the stand-in the edit box opens with', () => {
    const composer = createChatGptAdapter().composerFor(editElements().editor);
    expect(composer?.readPrompt()).toBe(
      'Please reply to standin.1@example.net about the plan',
    );
  });

  it('never confuses the edit box with the main composer', () => {
    const adapter = createChatGptAdapter();
    const { editor, send } = editElements();
    const main = adapter.getMainComposer();
    const mainEditor = main?.getEditor();
    if (!main || !mainEditor) throw new Error('no main composer');
    expect(mainEditor).not.toBe(editor);
    expect(main.getSendButton()).not.toBe(send);
    expect(adapter.composerFor(mainEditor)?.kind).toBe('main');
    expect(adapter.composerFor(editor)?.getSendButton()).toBe(send);
  });

  it('does not take the edit box as the main composer when that is absent', () => {
    loadComposer(editBoxHtml);
    const adapter = createChatGptAdapter();
    expect(adapter.getMainComposer()).toBeNull();
    expect(adapter.composerFor(editElements().editor)?.kind).toBe('edit');
  });

  it('treats Send, Enter and submit as sends, and Cancel as not a send', () => {
    const adapter = createChatGptAdapter();
    const { form, editor, send, cancel } = editElements();
    const click = () =>
      new MouseEvent('click', { bubbles: true, cancelable: true });
    const atTarget = (event: Event, el: EventTarget): Event => {
      Object.defineProperty(event, 'target', { value: el });
      return event;
    };
    expect(sendEventComposer(adapter, atTarget(click(), send))?.kind).toBe(
      'edit',
    );
    expect(sendEventComposer(adapter, atTarget(click(), cancel))).toBeNull();
    expect(
      sendEventComposer(
        adapter,
        atTarget(new KeyboardEvent('keydown', { key: 'Enter' }), editor),
      )?.kind,
    ).toBe('edit');
    expect(
      sendEventComposer(adapter, atTarget(new Event('submit'), form))?.kind,
    ).toBe('edit');
  });

  it('clicks the Send button of the edit box on triggerSend', () => {
    const adapter = createChatGptAdapter();
    const { editor, send } = editElements();
    const onEditSend = vi.fn((event: Event) => {
      event.preventDefault();
    });
    send.addEventListener('click', onEditSend);
    const mainSend = vi.fn((event: Event) => {
      event.preventDefault();
    });
    adapter
      .getMainComposer()
      ?.getSendButton()
      ?.addEventListener('click', mainSend);

    adapter.composerFor(editor)?.triggerSend();
    expect(onEditSend).toHaveBeenCalledTimes(1);
    expect(mainSend).not.toHaveBeenCalled();
  });

  it('fails closed once the edit box has closed', () => {
    const adapter = createChatGptAdapter();
    const { form, editor } = editElements();
    const composer = adapter.composerFor(editor);
    form.remove();
    expect(() => composer?.readPrompt()).toThrow(AdapterError);
    expect(() => {
      composer?.triggerSend();
    }).toThrow(AdapterError);
  });

  it('is not a message container, so restoration never reaches it', () => {
    const adapter = createChatGptAdapter();
    expect(adapter.getMessageContainer(editElements().editor)).toBeNull();
  });
});

describe('ChatGPT request rules', () => {
  const url = (path: string, host = 'chatgpt.com') =>
    new URL(`https://${host}${path}`);

  it.each([
    ['/backend-api/f/conversation', 'POST', true],
    ['/backend-api/conversation', 'POST', true],
    ['/backend-api/f/conversation/prepare', 'post', true],
    ['/backend-api/f/conversation', 'GET', false],
    ['/backend-api/conversations', 'POST', false],
    ['/backend-api/settings', 'POST', false],
  ] as const)('%s %s → %s', (path, method, expected) => {
    expect(chatgptNetRules.isMessageEndpoint(url(path), method)).toBe(expected);
  });

  it('only matches chatgpt.com', () => {
    expect(
      chatgptNetRules.isMessageEndpoint(
        url('/backend-api/f/conversation', 'example.org'),
        'POST',
      ),
    ).toBe(false);
  });

  it('extracts message text from new-message and edit bodies', () => {
    const body = {
      action: 'next',
      messages: [
        {
          author: { role: 'user' },
          content: { content_type: 'text', parts: ['hello test one'] },
        },
      ],
    };
    expect(chatgptNetRules.messageTexts(body)).toContain('hello test one');
  });

  it('has no message text in a regenerate body', () => {
    expect(
      chatgptNetRules.messageTexts({ action: 'variant', messages: [] }),
    ).toEqual([]);
  });

  it('reports an unexpected shape as null, so everything is checked', () => {
    expect(chatgptNetRules.messageTexts({ prompt: 'x' })).toBeNull();
    expect(chatgptNetRules.messageTexts('text')).toBeNull();
  });
});
