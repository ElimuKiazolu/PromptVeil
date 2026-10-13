export type SiteId = 'chatgpt' | 'gemini' | 'claude';

/**
 * Everything site-specific lives behind this interface, so a site change is a
 * one-file fix in the matching adapter.
 */
export interface SiteAdapter {
  readonly id: SiteId;
  matches(url: URL): boolean;
  /** The prompt editor (textarea or contenteditable), or null if not rendered. */
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
