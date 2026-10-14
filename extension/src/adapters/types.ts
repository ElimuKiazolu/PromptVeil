export type SiteId = 'chatgpt' | 'gemini' | 'claude';

/** 'main' is the page's prompt composer; 'edit' edits an earlier message. */
export type ComposerKind = 'main' | 'edit';

/** One place where the user writes and sends a prompt. */
export interface Composer {
  readonly kind: ComposerKind;
  /** The editor (textarea or contenteditable), or null if it is gone. */
  getEditor(): HTMLElement | null;
  /** The prompt exactly as the site will send it. */
  readPrompt(): string;
  /**
   * Replaces the prompt through the site's own input handling. Resolves only
   * once the editor reads back exactly `text`; rejects otherwise.
   */
  writePrompt(text: string): Promise<void>;
  getSendButton(): HTMLElement | null;
  /** Sends the current prompt. Throws if the site is not ready to send. */
  triggerSend(): void;
}

/**
 * Everything site-specific lives behind this interface, so a site change is a
 * one-file fix in the matching adapter.
 */
export interface SiteAdapter {
  readonly id: SiteId;
  matches(url: URL): boolean;
  /** The page's main composer, or null if it is not rendered. */
  getMainComposer(): Composer | null;
  /**
   * The composer an event target belongs to (its editor, send button or
   * form), or null when the target is not part of any composer.
   */
  composerFor(target: EventTarget | null): Composer | null;
  /** Conversation ID from the URL; null for a new chat. */
  getConversationId(): string | null;
  /**
   * User and assistant message elements in document order, outermost match
   * only. Limited to `within` when given.
   */
  getMessageContainers(within?: ParentNode): HTMLElement[];
  /** The message element containing `node`, or null outside messages. */
  getMessageContainer(node: Node): HTMLElement | null;
  isAssistantMessage(el: HTMLElement): boolean;
  /**
   * Optional site signal that an assistant reply has finished streaming.
   * Without it, a reply counts as finished after a quiet period.
   */
  isReplyComplete?(container: HTMLElement): boolean;
}

/**
 * How the request safety net recognises a site's message requests. Pure
 * functions: the MAIN-world net uses them without any page DOM.
 */
export interface SiteNetRules {
  /** True for the request(s) that send prompt text to the chatbot. */
  isMessageEndpoint(url: URL, method: string): boolean;
  /**
   * The user's message text in a parsed message-request body, or null when
   * the body does not have the expected shape (then all text is checked).
   */
  messageTexts(body: unknown): string[] | null;
}

export type AdapterErrorCode =
  | 'editor-missing'
  | 'send-button-missing'
  | 'send-button-disabled'
  | 'send-button-stop'
  | 'write-mismatch';

/** Thrown by adapters; carries a fixed code and never any prompt text. */
export class AdapterError extends Error {
  readonly code: AdapterErrorCode;

  constructor(code: AdapterErrorCode) {
    super(code);
    this.name = 'AdapterError';
    this.code = code;
  }
}
