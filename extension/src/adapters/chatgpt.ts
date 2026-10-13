import { AdapterError, type SiteAdapter } from './types.ts';

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
} as const;

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
  doc: Document,
  selectors: readonly string[],
): HTMLElement | null {
  for (const selector of selectors) {
    const found = doc.querySelector<HTMLElement>(selector);
    if (found) return found;
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

export function createChatGptAdapter(doc: Document = document): SiteAdapter {
  const getEditor = (): HTMLElement | null => queryFirst(doc, SELECTORS.editor);

  const readPrompt = (): string => {
    const editor = getEditor();
    if (!editor) throw new AdapterError('editor-missing');
    return normalise(blockLines(editor).join('\n'));
  };

  const getSendButton = (): HTMLElement | null =>
    queryFirst(doc, SELECTORS.sendButton);

  return {
    id: 'chatgpt',

    matches: (url) => url.hostname === HOSTNAME,

    getEditor,

    readPrompt,

    async writePrompt(text) {
      const editor = getEditor();
      if (!editor) throw new AdapterError('editor-missing');
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

    getSendButton,

    triggerSend() {
      const button = getSendButton();
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

    getConversationId: () => conversationIdFromUrl(new URL(doc.location.href)),

    getMessageContainers() {
      throw new AdapterError('not-implemented');
    },

    isAssistantMessage() {
      throw new AdapterError('not-implemented');
    },
  };
}
