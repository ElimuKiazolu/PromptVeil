import {
  AdapterError,
  type Composer,
  type ComposerKind,
  type SiteAdapter,
} from '@/src/adapters/types.ts';

export interface Harness {
  adapter: SiteAdapter;
  /** The main composer. */
  composer: Composer;
  editor: HTMLElement;
  button: HTMLButtonElement;
  form: HTMLFormElement;
  /** An edit-message box: a second composer with its own editor and button. */
  edit: {
    composer: Composer;
    editor: HTMLElement;
    button: HTMLButtonElement;
    form: HTMLFormElement;
  };
  /** A message area, outside the composers, for restoration tests. */
  message: HTMLElement;
  /** Sends the site itself performed from the main composer. */
  siteSends: string[];
  /** Sends the site itself performed from the edit box. */
  editSends: string[];
  /** Calls to triggerSend on any composer. */
  triggered: number;
  /** Number of upcoming writePrompt calls that fail after a partial write. */
  failingWrites: number;
}

function composerForm(): {
  form: HTMLFormElement;
  editor: HTMLElement;
  button: HTMLButtonElement;
} {
  const form = document.createElement('form');
  const editor = document.createElement('div');
  editor.setAttribute('contenteditable', 'true');
  const button = document.createElement('button');
  button.type = 'submit';
  button.append(document.createElement('span'));
  form.append(editor, button);
  form.addEventListener('submit', (event) => {
    event.preventDefault();
  });
  return { form, editor, button };
}

export function setUp(): Harness {
  const main = composerForm();
  const edit = composerForm();
  const message = document.createElement('div');
  document.body.replaceChildren(message, edit.form, main.form);

  const sends = { main: [] as string[], edit: [] as string[] };
  // The site's own handlers, which must only ever see the final text.
  for (const [kind, box] of [
    ['main', main],
    ['edit', edit],
  ] as const) {
    box.editor.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey) {
        sends[kind].push(box.editor.textContent);
      }
    });
    box.button.addEventListener('click', () => {
      sends[kind].push(box.editor.textContent);
    });
  }

  const counters = { triggered: 0, failingWrites: 0 };

  const fakeComposer = (
    kind: ComposerKind,
    box: { editor: HTMLElement; button: HTMLButtonElement },
  ): Composer => ({
    kind,
    getEditor: () => box.editor,
    readPrompt: () => box.editor.textContent,
    writePrompt: async (text) => {
      await Promise.resolve();
      if (counters.failingWrites > 0) {
        counters.failingWrites -= 1;
        box.editor.textContent = 'partially written';
        throw new AdapterError('write-mismatch');
      }
      box.editor.textContent = text;
    },
    getSendButton: () => box.button,
    triggerSend: () => {
      counters.triggered += 1;
      box.button.click();
    },
  });

  const mainComposer = fakeComposer('main', main);
  const editComposer = fakeComposer('edit', edit);

  const adapter: SiteAdapter = {
    id: 'chatgpt',
    matches: () => true,
    getMainComposer: () => mainComposer,
    composerFor: (target) => {
      if (!(target instanceof Node)) return null;
      if (main.form.contains(target)) return mainComposer;
      if (edit.form.contains(target)) return editComposer;
      return null;
    },
    getConversationId: () => null,
    getMessageContainers: () => [message],
    getMessageContainer: (node) => (message.contains(node) ? message : null),
    isAssistantMessage: () => false,
  };

  return {
    adapter,
    composer: mainComposer,
    editor: main.editor,
    button: main.button,
    form: main.form,
    edit: { composer: editComposer, ...edit },
    message,
    siteSends: sends.main,
    editSends: sends.edit,
    get triggered() {
      return counters.triggered;
    },
    get failingWrites() {
      return counters.failingWrites;
    },
    set failingWrites(value: number) {
      counters.failingWrites = value;
    },
  };
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
