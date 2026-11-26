import { collectJsonValues } from '@/src/core/net/checks.ts';
import {
  AdapterError,
  type Composer,
  type ComposerKind,
  type NetEndpoint,
  type NetBackground,
  type NetSkip,
  type SiteAdapter,
  type SiteNetRules,
} from './types.ts';

/**
 * ChatGPT selectors. Each list is tried in order: the first entry is the
 * current stable hook, later entries are fallbacks for older or variant
 * layouts. Localised attributes (aria-label) are deliberately not used.
 */
const SELECTORS = {
  // The main composer's form. In-app navigation (e.g. "New chat") can mount
  // a new composer while the previous one is still in the page, so every
  // event is resolved to the composer it happened in, never to the first
  // composer of the document.
  composerForm: ['form[data-chatgpt-composer]'],
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
    // A Writing card reply: an editor view (ProseMirror) holding the
    // generated text. Recognised so its stand-ins are counted; the text is
    // editor-managed and never rewritten (see the restorer).
    '.writing-block-editor',
    // Earlier layouts.
    '[data-message-author-role="assistant"]',
  ],
  // Editors on replies the user can type into: the writing card's editor
  // view. Any other editable root inside a reply counts too (see
  // cardEditorFor).
  cardContainer: ['.writing-block-editor'],
  editableRoot: ['[contenteditable="true"]', '[contenteditable=""]'],
} as const;

/**
 * ChatGPT's requests for the safety net.
 *
 * - Messages: new messages and edits are POST /backend-api/f/conversation
 *   with action "next" and the text in messages[].content.parts; regenerate
 *   uses action "variant" with no messages; …/conversation/prepare is sent
 *   while typing. The un-prefixed path is the earlier form.
 * - Writing blocks (email and document cards in replies): every edit of a
 *   card is saved with a POST to a path ending in …/writing-blocks, body
 *   {conversation_id, message_id, updated_at, writing_block: {content
 *   (markdown), metadata: {subject, recipient, suggested_followups},
 *   variant}} (owner's live capture, P6.3).
 * Every other write to chatgpt.com is checked with the free-text selection.
 */
const NET = {
  hostname: 'chatgpt.com',
  /** Methods that send data; 'SEND' is a WebSocket message. */
  writeMethods: new Set(['POST', 'PUT', 'PATCH', 'SEND']),
  messagePath: /^\/backend-api\/(?:f\/)?conversation(?:\/prepare)?\/?$/,
  writingBlockPath:
    /^\/backend-api\/(?:[^/]+\/)*writing[-_]blocks?(?:\/[^/]+)?\/?$/,
} as const;

const USER_MESSAGE = SELECTORS.userMessage.join(', ');
const ASSISTANT_MESSAGE = SELECTORS.assistantMessage.join(', ');
const ANY_MESSAGE = `${USER_MESSAGE}, ${ASSISTANT_MESSAGE}`;
const EDIT_FORM = SELECTORS.editForm.join(', ');
const COMPOSER_FORM = SELECTORS.composerForm.join(', ');
const CARD_CONTAINER = SELECTORS.cardContainer.join(', ');
const EDITABLE_ROOT = SELECTORS.editableRoot.join(', ');

const HOSTNAME = 'chatgpt.com';

/**
 * Matches /c/<id>, also when nested under /g/<gpt-or-project>/. IDs are
 * 8–128 characters, the vault's ChatGPT format (src/shared/conversation-id.ts).
 */
const CONVERSATION_PATH = /(?:^|\/)c\/([A-Za-z0-9-]{8,128})(?:\/|$)/;

/**
 * ChatGPT's own placeholder for a chat the server has not named yet: right
 * after the first send of an in-app "New chat" the URL shows
 * /c/local-chatgpt%3A<uuid> (live, 58ee498) until the real /c/<id> arrives.
 * Such a chat is still pending (TR-A5); any /c/ segment that is not a
 * server ID (other characters, a "local-" prefix) reads as no ID.
 */
const LOCAL_ID = /^local-/i;

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
  const id = CONVERSATION_PATH.exec(url.pathname)?.[1] ?? null;
  return id === null || LOCAL_ID.test(id) ? null : id;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The user's message text: every string of each message's content. */
export function messageTexts(body: unknown): string[] | null {
  if (!isRecord(body)) return null;
  const { messages } = body;
  if (!Array.isArray(messages)) return null;
  const texts: string[] = [];
  for (const message of messages) {
    // Every string in each message's content counts, so text parts nested
    // in other part types are covered too.
    const content: unknown = isRecord(message) ? message.content : message;
    texts.push(...collectJsonValues(content));
  }
  return texts;
}

/**
 * The text of a saved writing block: its content and the subject,
 * recipient and suggested follow-ups of its metadata (any of these may be
 * missing; the content may not).
 */
export function writingBlockTexts(body: unknown): string[] | null {
  if (!isRecord(body)) return null;
  const block = body.writing_block;
  if (!isRecord(block) || typeof block.content !== 'string') return null;
  const texts = [block.content];
  const { metadata } = block;
  if (isRecord(metadata)) {
    for (const field of ['subject', 'recipient', 'suggested_followups']) {
      texts.push(...collectJsonValues(metadata[field]));
    }
  }
  return texts;
}

const ENDPOINTS: readonly NetEndpoint[] = [
  {
    surface: 'message',
    matches: (url, method) =>
      method === 'POST' && NET.messagePath.test(url.pathname),
    userTexts: messageTexts,
    loggedObjects: [],
  },
  {
    surface: 'writing-block',
    matches: (url, method) =>
      method !== 'SEND' && NET.writingBlockPath.test(url.pathname),
    userTexts: writingBlockTexts,
    loggedObjects: ['writing_block', 'writing_block.metadata'],
  },
];

/**
 * First-party writes known to carry no user text. Empty until the live
 * surface tour (P6.3) shows one with evidence; analytics are not skipped on
 * assumption (their events can carry page text). Each entry must be one
 * exact method and path, with the evidence in a comment above it.
 */
const SKIP: readonly NetSkip[] = [];

/**
 * ChatGPT's own background writes: checked and blocked like every write,
 * but never shown to the user, who did not cause them. Each entry names its
 * evidence; matched on first-party hosts only (isFirstPartyWrite).
 */
const BACKGROUND: readonly NetBackground[] = [
  // Statsig event batches: POST …/ces/v1/rgstr, gzip JSON with events[]
  // (@statsig/client-core 3.33.8 source, P6.3; live 3a9bcb0: blocked
  // repeatedly after a card edit and again after a browser restart, because
  // the SDK stores failed batches and retries them).
  {
    matches: (url, method) =>
      method === 'POST' && /\/ces\/v1\/rgstr\/?$/.test(url.pathname),
  },
  // Telemetry intake: POST /v1/telemetry/intake, text body (live 3a9bcb0,
  // blocked with the Statsig batches, no user action).
  {
    matches: (url, method) =>
      method === 'POST' && url.pathname === '/v1/telemetry/intake',
  },
  // Anti-abuse checks before a message: POST /backend-api/sentinel/…, e.g.
  // chat-requirements/finalize with prepare_token, proofofwork, turnstile
  // (live 3a9bcb0, during an ordinary masked send).
  {
    matches: (url, method) =>
      method === 'POST' && url.pathname.startsWith('/backend-api/sentinel/'),
  },
];

const isChatGptHost = (hostname: string): boolean =>
  hostname === NET.hostname || hostname.endsWith(`.${NET.hostname}`);

/**
 * Request rules for the MAIN-world safety net. Methods arrive upper-cased
 * (src/net/request.ts).
 */
export const chatgptNetRules: SiteNetRules = {
  isFirstPartyWrite: (url, method) =>
    isChatGptHost(url.hostname) && NET.writeMethods.has(method),
  endpoints: ENDPOINTS,
  skip: SKIP,
  background: BACKGROUND,
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

/** The ChatGPT adapter: every optional SiteAdapter part is implemented. */
export type ChatGptAdapter = SiteAdapter &
  Required<Pick<SiteAdapter, 'cardEditorFor' | 'readCardText'>>;

export function createChatGptAdapter(doc: Document = document): ChatGptAdapter {
  const isInEditForm = (el: Element): boolean => el.closest(EDIT_FORM) !== null;

  // Fallback selectors must never pick up an edit box as the main editor.
  const mainEditor = (): HTMLElement | null =>
    queryFirst(doc, SELECTORS.editor, (el) => !isInEditForm(el));
  const mainSendButton = (): HTMLElement | null =>
    queryFirst(doc, SELECTORS.sendButton, (el) => !isInEditForm(el));

  /** Layouts without the form marker: the first main editor and button. */
  const legacyComposer = proseMirrorComposer(
    doc,
    'main',
    mainEditor,
    mainSendButton,
  );

  /**
   * One composer per main composer form, bound to that form: its editor
   * and Send button are looked up inside it on every call, so a composer
   * the page removed reports its editor missing (the send fails closed)
   * instead of reaching another composer.
   */
  const formComposers = new WeakMap<HTMLFormElement, Composer>();
  const composerOfForm = (form: HTMLFormElement): Composer => {
    let composer = formComposers.get(form);
    if (composer === undefined) {
      composer = proseMirrorComposer(
        doc,
        'main',
        () => (form.isConnected ? queryFirst(form, SELECTORS.editor) : null),
        () =>
          form.isConnected ? queryFirst(form, SELECTORS.sendButton) : null,
      );
      formComposers.set(form, composer);
    }
    return composer;
  };

  const mainForms = (): HTMLFormElement[] =>
    Array.from(doc.querySelectorAll<HTMLFormElement>(COMPOSER_FORM)).filter(
      (form) => !isInEditForm(form),
    );

  /** Hidden by the page (kept mounted while another composer shows). */
  const isHidden = (el: Element): boolean =>
    el.closest('[hidden], [inert], [aria-hidden="true"]') !== null;

  /**
   * The composer the user works in: the one holding the focus, else the
   * first one the page does not hide, else the first one.
   */
  const currentMainComposer = (): Composer | null => {
    const forms = mainForms();
    const active = doc.activeElement;
    const chosen =
      forms.find((form) => active !== null && form.contains(active)) ??
      forms.find((form) => !isHidden(form)) ??
      forms[0];
    if (chosen !== undefined) return composerOfForm(chosen);
    return mainEditor() ? legacyComposer : null;
  };

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

    getMainComposer: currentMainComposer,

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

      // The composer form the event happened in, whichever composer of
      // the page that is.
      const form = el.closest<HTMLFormElement>(COMPOSER_FORM);
      if (form) return composerOfForm(form);
      // With marked composers on the page, anything outside them (a card
      // editor, the page) is not a composer.
      if (mainForms().length > 0) return null;

      // Earlier layouts without the form marker: the first main editor.
      const editor = mainEditor();
      if (!editor) return null;
      const legacyForm = editor.closest('form');
      const button = mainSendButton();
      const inMain =
        editor.contains(el) ||
        (legacyForm?.contains(el) ?? false) ||
        (button?.contains(el) ?? false);
      return inMain ? legacyComposer : null;
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

    cardEditorFor(target) {
      const el =
        target instanceof Element
          ? target
          : target instanceof Node
            ? target.parentElement
            : null;
      const root = el?.closest<HTMLElement>(EDITABLE_ROOT) ?? null;
      if (root === null || this.composerFor(root) !== null) return null;
      if (root.closest(CARD_CONTAINER) !== null) return root;
      const message = outermostMessage(root);
      return message !== null && message.closest(ASSISTANT_MESSAGE) !== null
        ? root
        : null;
    },

    // Blank paragraphs (and layout whitespace between blocks) carry nothing
    // to check; each paragraph is its own block of text.
    readCardText: (editor) =>
      normalise(
        blockLines(editor)
          .filter((line) => line.trim() !== '')
          .join('\n\n'),
      ),
  };
}
