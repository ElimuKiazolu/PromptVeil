import { collectJsonStrings } from '@/src/core/net/checks.ts';
import {
  AdapterError,
  type Composer,
  type ComposerKind,
  type SiteAdapter,
  type SiteNetRules,
} from './types.ts';

/**
 * ChatGPT selectors. Each list is tried in order: the first entry is the
 * current stable hook, later entries are fallbacks for older or variant
 * layouts. Localised attributes (aria-label) are deliberately not used.
 */
const SELECTORS = {
  editor: [
    // Composer form marker plus the ProseMirror textbox inside it.
    'form[data-chatgpt-composer] [contenteditable="true"][role="textbox"]',
    // Earlier layouts gave the editor this id.
    '#prompt-textarea',
    '.ProseMirror[contenteditable="true"]',
  ],
  sendButton: [
    'form[data-chatgpt-composer] button[type="submit"]',
    // Earlier layouts.
    'button[data-testid="send-button"]',
    '#composer-submit-button',
  ],
  // The composer button in its "stop generating" state. While a reply
  // streams and the editor has text, the composer keeps its Send button
  // (clicking it queues the message); this hook is refused regardless.
  stopButton: ['[data-testid="stop-button"]'],
  // Editing a sent message replaces its bubble with a form inside the user
  // turn: a ProseMirror textbox, a Cancel button and a submit (Send) button.
  editForm: [
    '[data-chatgpt-search-unit-key$=":user"] form:not([data-chatgpt-composer])',
    // Earlier layouts.
    '[data-message-author-role="user"] form:not([data-chatgpt-composer])',
  ],
  editEditor: [
    '[contenteditable="true"][role="textbox"]',
    '.ProseMirror[contenteditable="true"]',
  ],
  editSendButton: ['button[type="submit"]'],
  userMessage: [
    // The user's message bubble.
    '[data-user-message-bubble="true"]',
    // Earlier layouts marked each message with its author role.
    '[data-message-author-role="user"]',
  ],
  assistantMessage: [
    // The rendered markdown of an assistant reply.
    '[data-markdown-text-style="assistant-message"]',
    // The reply renderer root inside it.
    '[data-dil-message-id]',
    // Earlier layouts.
    '[data-message-author-role="assistant"]',
  ],
} as const;

/**
 * Requests that carry prompt text. New messages and edits are
 * POST /backend-api/f/conversation with action "next" and the text in
 * messages[].content.parts; regenerate uses action "variant" with no
 * messages. The un-prefixed path is the earlier form of the same endpoint.
 * Every POST below it counts too (e.g. requests prepared while typing), so
 * draft text sent before the user presses Enter is checked as well.
 */
const NET = {
  hostname: 'chatgpt.com',
  messagePath: /^\/backend-api\/(?:f\/)?conversation(?:\/|$)/,
  messageMethod: 'POST',
} as const;

const USER_MESSAGE = SELECTORS.userMessage.join(', ');
const ASSISTANT_MESSAGE = SELECTORS.assistantMessage.join(', ');
const ANY_MESSAGE = `${USER_MESSAGE}, ${ASSISTANT_MESSAGE}`;
const EDIT_FORM = SELECTORS.editForm.join(', ');

const HOSTNAME = 'chatgpt.com';

/** Matches /c/<id>, also when nested under /g/<gpt-or-project>/. */
const CONVERSATION_PATH = /(?:^|\/)c\/([A-Za-z0-9-]{8,})(?:\/|$)/;

/** ProseMirror adds this <br> to keep empty blocks open; it is not content. */
const TRAILING_BREAK_CLASS = 'ProseMirror-trailingBreak';

const BLOCK_TAGS = new Set([
  'P',
  'DIV',
  'PRE',
  'LI',
  'UL',
  'OL',
  'BLOCKQUOTE',
  'H1',
  'H2',
  'H3',
  'H4',
  'H5',
  'H6',
]);

/** Paragraph breaks are compared as \n and non-breaking spaces as spaces. */
function normalise(text: string): string {
  return text.replace(/\r\n?/g, '\n').replace(/\xA0/g, ' ');
}

function queryFirst(
  root: ParentNode,
  selectors: readonly string[],
  accept: (el: HTMLElement) => boolean = () => true,
): HTMLElement | null {
  for (const selector of selectors) {
    for (const found of Array.from(
      root.querySelectorAll<HTMLElement>(selector),
    )) {
      if (accept(found)) return found;
    }
  }
  return null;
}

/** The outermost message element containing `el` (or `el` itself). */
function outermostMessage(el: Element): HTMLElement | null {
  let found = el.closest<HTMLElement>(ANY_MESSAGE);
  while (found) {
    const outer = found.parentElement?.closest<HTMLElement>(ANY_MESSAGE);
    if (!outer) return found;
    found = outer;
  }
  return null;
}

function isBlock(node: Node): node is HTMLElement {
  return node instanceof HTMLElement && BLOCK_TAGS.has(node.tagName);
}

function hasBlockChild(el: HTMLElement): boolean {
  return Array.from(el.childNodes).some(isBlock);
}

function inlineText(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return node.nodeValue ?? '';
  if (node instanceof HTMLBRElement) {
    return node.classList.contains(TRAILING_BREAK_CLASS) ? '' : '\n';
  }
  return Array.from(node.childNodes).map(inlineText).join('');
}

/** One entry per leaf block; blank paragraphs become empty lines. */
function blockLines(root: HTMLElement): string[] {
  const lines: string[] = [];
  let inline: string | null = null;
  for (const child of Array.from(root.childNodes)) {
    if (isBlock(child)) {
      if (inline !== null) {
        lines.push(inline);
        inline = null;
      }
      if (hasBlockChild(child)) lines.push(...blockLines(child));
      else lines.push(inlineText(child));
    } else {
      inline = (inline ?? '') + inlineText(child);
    }
  }
  if (inline !== null) lines.push(inline);
  return lines;
}

/** Lets the editor's mutation handling and the page's re-render complete. */
function settle(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

export function conversationIdFromUrl(url: URL): string | null {
  return CONVERSATION_PATH.exec(url.pathname)?.[1] ?? null;
}

/** Request rules for the MAIN-world safety net. */
export const chatgptNetRules: SiteNetRules = {
  isMessageEndpoint: (url, method) =>
    url.hostname === NET.hostname &&
    method.toUpperCase() === NET.messageMethod &&
    NET.messagePath.test(url.pathname),

  messageTexts(body) {
    if (typeof body !== 'object' || body === null) return null;
    const { messages } = body as { messages?: unknown };
    if (!Array.isArray(messages)) return null;
    const texts: string[] = [];
    for (const message of messages) {
      // Every string in each message's content counts, so text parts nested
      // in other part types are covered too.
      const content: unknown =
        typeof message === 'object' && message !== null
          ? (message as { content?: unknown }).content
          : message;
      texts.push(...collectJsonStrings(content));
    }
    return texts;
  },
};

/**
 * A composer backed by a ProseMirror editor. `resolveEditor` and
 * `resolveSendButton` are re-run on every call, so a re-rendered editor is
 * found again (main composer) or reported missing (edit box), never guessed.
 */
function proseMirrorComposer(
  doc: Document,
  kind: ComposerKind,
  resolveEditor: () => HTMLElement | null,
  resolveSendButton: () => HTMLElement | null,
): Composer {
  const editorOrThrow = (): HTMLElement => {
    const editor = resolveEditor();
    if (!editor?.isConnected) throw new AdapterError('editor-missing');
    return editor;
  };

  const readPrompt = (): string =>
    normalise(blockLines(editorOrThrow()).join('\n'));

  return {
    kind,
    getEditor: resolveEditor,
    readPrompt,

    async writePrompt(text) {
      const editor = editorOrThrow();
      const target = normalise(text);

      // Select the whole editor, then replace it through the browser's native
      // editing command. The editor observes the resulting input events and
      // DOM changes and updates its own state, which is what the site sends.
      // Each \n becomes a paragraph break, so line breaks are preserved.
      editor.focus();
      const selection = doc.getSelection();
      if (!selection) throw new AdapterError('write-mismatch');
      const range = doc.createRange();
      range.selectNodeContents(editor);
      selection.removeAllRanges();
      selection.addRange(range);

      const applied =
        target === ''
          ? doc.execCommand('delete')
          : doc.execCommand('insertText', false, target);
      if (!applied) throw new AdapterError('write-mismatch');

      await settle();
      if (readPrompt() !== target) throw new AdapterError('write-mismatch');
    },

    getSendButton: resolveSendButton,

    triggerSend() {
      const button = resolveSendButton();
      if (!button) throw new AdapterError('send-button-missing');
      const disabled =
        (button instanceof HTMLButtonElement && button.disabled) ||
        button.getAttribute('aria-disabled') === 'true';
      if (disabled) throw new AdapterError('send-button-disabled');
      if (SELECTORS.stopButton.some((selector) => button.matches(selector))) {
        throw new AdapterError('send-button-stop');
      }
      button.click();
    },
  };
}

export function createChatGptAdapter(doc: Document = document): SiteAdapter {
  const isInEditForm = (el: Element): boolean => el.closest(EDIT_FORM) !== null;

  // Fallback selectors must never pick up an edit box as the main editor.
  const mainEditor = (): HTMLElement | null =>
    queryFirst(doc, SELECTORS.editor, (el) => !isInEditForm(el));
  const mainSendButton = (): HTMLElement | null =>
    queryFirst(doc, SELECTORS.sendButton, (el) => !isInEditForm(el));

  const mainComposer = proseMirrorComposer(
    doc,
    'main',
    mainEditor,
    mainSendButton,
  );

  const editComposer = (form: HTMLFormElement): Composer | null => {
    const editor = queryFirst(form, SELECTORS.editEditor);
    if (!editor) return null;
    return proseMirrorComposer(
      doc,
      'edit',
      () => (editor.isConnected ? editor : null),
      () =>
        form.isConnected ? queryFirst(form, SELECTORS.editSendButton) : null,
    );
  };

  return {
    id: 'chatgpt',

    matches: (url) => url.hostname === HOSTNAME,

    getMainComposer: () => (mainEditor() ? mainComposer : null),

    composerFor(target) {
      const el =
        target instanceof Element
          ? target
          : target instanceof Node
            ? target.parentElement
            : null;
      if (!el) return null;

      // An edit box is checked first: its form is its own composer.
      const editForm = el.closest<HTMLFormElement>(EDIT_FORM);
      if (editForm) return editComposer(editForm);

      const editor = mainEditor();
      if (!editor) return null;
      const form = editor.closest('form');
      const button = mainSendButton();
      const inMain =
        editor.contains(el) ||
        (form?.contains(el) ?? false) ||
        (button?.contains(el) ?? false);
      return inMain ? mainComposer : null;
    },

    getConversationId: () => conversationIdFromUrl(new URL(doc.location.href)),

    getMessageContainers(within = doc) {
      const matches = Array.from(
        within.querySelectorAll<HTMLElement>(ANY_MESSAGE),
      );
      // Keep only outermost matches; nested hooks belong to the same message.
      return matches.filter((el) => !el.parentElement?.closest(ANY_MESSAGE));
    },

    getMessageContainer(node) {
      const el = node instanceof Element ? node : node.parentElement;
      return el ? outermostMessage(el) : null;
    },

    isAssistantMessage(el) {
      return el.closest(ASSISTANT_MESSAGE) !== null;
    },
  };
}
