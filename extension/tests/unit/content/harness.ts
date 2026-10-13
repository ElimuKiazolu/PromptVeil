import { AdapterError, type SiteAdapter } from '@/src/adapters/types.ts';

export interface Harness {
  adapter: SiteAdapter;
  editor: HTMLElement;
  button: HTMLButtonElement;
  form: HTMLFormElement;
  /** A message area, outside the composer, for restoration tests. */
  message: HTMLElement;
  /** Sends the site itself would have performed (its own handlers). */
  siteSends: string[];
  /** Calls to adapter.triggerSend. */
  triggered: number;
  /** Number of upcoming writePrompt calls that fail after a partial write. */
  failingWrites: number;
}

export function setUp(): Harness {
  const form = document.createElement('form');
  const editor = document.createElement('div');
  editor.contentEditable = 'true';
  const button = document.createElement('button');
  button.type = 'submit';
  button.append(document.createElement('span'));
  form.append(editor, button);
  const message = document.createElement('div');
  document.body.replaceChildren(message, form);

  const harness: Harness = {
    adapter: {} as SiteAdapter,
    editor,
    button,
    form,
    message,
    siteSends: [],
    triggered: 0,
    failingWrites: 0,
  };

  // The site's own handlers, which must only ever see the final text.
  editor.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      harness.siteSends.push(editor.textContent);
    }
  });
  button.addEventListener('click', () => {
    harness.siteSends.push(editor.textContent);
  });
  form.addEventListener('submit', (event) => {
    event.preventDefault();
  });

  harness.adapter = {
    id: 'chatgpt',
    matches: () => true,
    getEditor: () => editor,
    readPrompt: () => editor.textContent,
    writePrompt: async (text) => {
      await Promise.resolve();
      if (harness.failingWrites > 0) {
        harness.failingWrites -= 1;
        editor.textContent = 'partially written';
        throw new AdapterError('write-mismatch');
      }
      editor.textContent = text;
    },
    getSendButton: () => button,
    triggerSend: () => {
      harness.triggered += 1;
      button.click();
    },
    getConversationId: () => null,
    getMessageContainers: () => [message],
    getMessageContainer: (node) => (message.contains(node) ? message : null),
    isAssistantMessage: () => false,
  };
  return harness;
}

export function pressKey(
  target: HTMLElement,
  init: KeyboardEventInit,
): KeyboardEvent {
  const event = new KeyboardEvent('keydown', {
    bubbles: true,
    cancelable: true,
    ...init,
  });
  target.dispatchEvent(event);
  return event;
}

export const flush = (): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
