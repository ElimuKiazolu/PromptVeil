import type { TabsLike } from '@/src/background/tab-notices.ts';
import type {
  MessageSenderLike,
  RuntimeLike,
  RuntimeListener,
} from '@/src/shared/messaging.ts';

export const EXTENSION_ID = 'abcdefghijklmnopabcdefghijklmnop';

/**
 * Delivers a message to listeners as Chromium does: the first reply wins;
 * with no listener it rejects ("no receiving end"); with listeners that all
 * stay silent it resolves undefined. Each listener gets a structured clone.
 */
function deliver(
  listeners: readonly RuntimeListener[],
  message: unknown,
  sender: MessageSenderLike,
): Promise<unknown> {
  if (listeners.length === 0) {
    return Promise.reject(
      new Error(
        'Could not establish connection. Receiving end does not exist.',
      ),
    );
  }
  return new Promise((resolve) => {
    const state = { pending: false, answered: false };
    const sendResponse = (response: unknown): void => {
      if (state.answered) return;
      state.answered = true;
      resolve(structuredClone(response));
    };
    for (const listener of listeners) {
      if (listener(structuredClone(message), sender, sendResponse) === true) {
        state.pending = true;
      }
    }
    if (!state.pending && !state.answered) resolve(undefined);
  });
}

class FakeRuntime implements RuntimeLike {
  readonly listeners = new Set<RuntimeListener>();
  id: string | undefined = EXTENSION_ID;

  private readonly send: (message: unknown) => Promise<unknown>;

  constructor(send: (message: unknown) => Promise<unknown>) {
    this.send = send;
  }

  sendMessage(message: unknown): Promise<unknown> {
    return this.send(message);
  }

  readonly onMessage = {
    addListener: (listener: RuntimeListener) => {
      this.listeners.add(listener);
    },
    removeListener: (listener: RuntimeListener) => {
      this.listeners.delete(listener);
    },
  };
}

export interface FakeTab {
  id: number;
  url: string;
  /** frameId the content script reports (0 = top frame). */
  frameId: number;
  /** The content script's runtime in this tab. */
  runtime: FakeRuntime;
}

/**
 * One extension: a service worker runtime, tabs with content scripts, and a
 * tabs API that sends to them. Messages from a tab carry the tab's sender
 * fields; messages to a tab come from the extension (no `tab`).
 */
export class FakeExtension {
  readonly background: FakeRuntime;
  readonly tabList: FakeTab[] = [];
  /** Every message the tabs API sent, by tab. */
  readonly sentToTabs: { tabId: number; message: unknown }[] = [];

  constructor() {
    this.background = new FakeRuntime(() =>
      Promise.reject(new Error('the background does not message itself')),
    );
  }

  openTab(url: string, options: { frameId?: number } = {}): FakeTab {
    const id = this.tabList.length + 1;
    const tab: FakeTab = {
      id,
      url,
      frameId: options.frameId ?? 0,
      runtime: new FakeRuntime((message) =>
        deliver([...this.background.listeners], message, {
          id: EXTENSION_ID,
          tab: { id },
          frameId: tab.frameId,
          url: tab.url,
        }),
      ),
    };
    this.tabList.push(tab);
    return tab;
  }

  readonly tabs: TabsLike = {
    query: (info) =>
      Promise.resolve(
        this.tabList
          .filter((tab) =>
            info.url.some((pattern) =>
              tab.url.startsWith(pattern.replace(/\*$/u, '')),
            ),
          )
          .map((tab) => ({ id: tab.id })),
      ),
    sendMessage: (tabId, message) => {
      this.sentToTabs.push({ tabId, message });
      const tab = this.tabList.find((candidate) => candidate.id === tabId);
      if (tab === undefined) return Promise.reject(new Error('no such tab'));
      return deliver([...tab.runtime.listeners], message, { id: EXTENSION_ID });
    },
  };
}
