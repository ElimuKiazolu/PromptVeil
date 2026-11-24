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
  /**
   * The editable root of a card editor on a reply (e.g. ChatGPT's writing
   * card) that `target` is in, or null. Composers and edit boxes are not
   * cards. Card editors are only ever read, never changed.
   */
  cardEditorFor?(target: EventTarget | null): HTMLElement | null;
  /** A card editor's text, paragraphs separated by blank lines. */
  readCardText?(editor: HTMLElement): string;
}

/** A site surface whose writes carry text the user typed. */
export type WriteSurface = 'message' | 'writing-block';

/**
 * A write endpoint the adapter knows exactly: which request it is and where
 * in the body the user's text is.
 */
export interface NetEndpoint {
  readonly surface: WriteSurface;
  matches(url: URL, method: string): boolean;
  /**
   * The user's text in a parsed body, or null when the body does not have
   * the expected shape (then the free-text selection checks it).
   */
  userTexts(body: unknown): string[] | null;
  /** Dot paths of nested objects whose key names the dev log shows. */
  readonly loggedObjects: readonly string[];
}

/**
 * A first-party write known to carry no user text. Every entry is exact
 * (one path and method) and documents the evidence in a comment; it never
 * depends on anything the page controls. Tier 2 still checks it.
 */
export interface NetSkip {
  matches(url: URL, method: string): boolean;
}

/**
 * How the request safety net reads a site's requests. Pure data and
 * functions: the MAIN-world net uses them without any page DOM.
 *
 * Every first-party write (a request that sends data to the site itself)
 * is checked for text the user typed: known endpoints by their extractor,
 * any other by the free-text selection (src/core/net/user-text.ts), so a
 * new site feature is checked from the day it appears.
 */
export interface SiteNetRules {
  /** True for a request that sends data to the site itself. */
  isFirstPartyWrite(url: URL, method: string): boolean;
  /** Known endpoints, tried in order. */
  readonly endpoints: readonly NetEndpoint[];
  /** First-party writes known to carry no user text. */
  readonly skip: readonly NetSkip[];
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
