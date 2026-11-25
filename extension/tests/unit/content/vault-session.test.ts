import { IDBFactory } from 'fake-indexeddb';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { conversationIdFromUrl } from '@/src/adapters/chatgpt.ts';
import { registerVaultHandlers } from '@/src/background/vault-host.ts';
import { startInstance } from '@/src/content/instance.ts';
import type { NetBridge } from '@/src/content/net-bridge.ts';
import { vaultLifecycle } from '@/src/content/vault-lifecycle.ts';
import {
  createVaultSession,
  VaultSessionError,
  type VaultSession,
} from '@/src/content/vault-session.ts';
import { STORE } from '@/src/core/vault/schema.ts';
import {
  createVaultService,
  type VaultService,
} from '@/src/core/vault/service.ts';
import { createPipeline, issueStandIns } from '@/src/core/pipeline.ts';
import { testEngine } from '../word-lists.ts';
import {
  createMessenger,
  PROTOCOL,
  type Messenger,
  type Protocol,
} from '@/src/shared/messaging.ts';
import type { MaskItem } from '@/src/shared/vault-protocol.ts';
import { clearRaw, openV1, webCrypto } from '../core/vault/harness.ts';
import { FakeExtension, type FakeTab } from '../extension-fakes.ts';
import { detectEmailsOnly } from '../spike-detect.ts';
import { flush, pressKey, setUp as setUpPage } from './harness.ts';

/**
 * The mappings of whole values: email mappings also bring the name pieces
 * a reply may derive from their local parts (tested in
 * vault-session-names.test.ts).
 */
const wholeMappings = (session: VaultSession) =>
  session.source.mappings().filter((m) => m.boundary !== 'derived');

const CONV_ID = '6800a1b2-c3d4-4e5f-8a9b-0c1d2e3f4a5b';
const OTHER_ID = '7900b2c3-d4e5-4f60-9b0c-1d2e3f4a5b6c';
const THIRD_ID = '8a01c3d4-e5f6-4071-8c1d-2e3f4a5b6c7d';
const NEW_CHAT = 'https://chatgpt.com/';
const CONV_URL = `https://chatgpt.com/c/${CONV_ID}`;
const OTHER_URL = `https://chatgpt.com/c/${OTHER_ID}`;

/** A fixture-style address (example.com/org are reserved for documentation). */
function email(local: string): MaskItem {
  const value = `${local}@example.com`;
  return {
    type: 'EMAIL',
    subtype: null,
    country: null,
    value,
    normalised: value.toLowerCase(),
  };
}

const DANA = email('dana.whitfield');
const ROBIN = email('robin.hale');

type Send = Messenger<Protocol>['send'];

interface World {
  ext: FakeExtension;
  vault: VaultService;
  factory: IDBFactory;
}

interface TabSession {
  tab: FakeTab;
  session: VaultSession;
  /** What happened in order: the net learning mappings, the source changing. */
  log: string[];
  /** Every request the session made, by name. */
  requests: string[];
  navigate(url: string): void;
}

const worlds: World[] = [];
const sessions: VaultSession[] = [];

function world(): World {
  const ext = new FakeExtension();
  const factory = new IDBFactory();
  const vault = createVaultService({ idb: factory, crypto: webCrypto });
  registerVaultHandlers({
    messenger: createMessenger(PROTOCOL, ext.background),
    vault,
    tabs: ext.tabs,
  });
  const created = { ext, vault, factory };
  worlds.push(created);
  return created;
}

/**
 * A tab with a session wired as the content script wires it. `wrap` may
 * intercept the session's requests.
 */
function openSession(
  { ext }: World,
  url: string,
  wrap: (send: Send) => Send = (send) => send,
): TabSession {
  const tab = ext.openTab(url);
  const messenger = createMessenger(PROTOCOL, tab.runtime);
  const log: string[] = [];
  const requests: string[] = [];
  const send = wrap(messenger.send.bind(messenger));
  const session = createVaultSession({
    adapter: {
      id: 'chatgpt',
      getConversationId: () => conversationIdFromUrl(new URL(tab.url)),
    },
    messenger: {
      send: (name, request, options) => {
        requests.push(name);
        return send(name, request, options);
      },
    },
    beforePublish: (mappings) => {
      const whole = mappings.filter((m) => m.boundary !== 'derived');
      log.push(`net ${whole.length.toString()}`);
    },
    randomUUID: () => crypto.randomUUID(),
  });
  session.source.subscribe(() => {
    log.push(`source ${wholeMappings(session).length.toString()}`);
  });
  const controller = new AbortController();
  vaultLifecycle(session, tab.runtime, window).start(controller.signal);
  sessions.push(session);
  return {
    tab,
    session,
    log,
    requests,
    navigate(next) {
      tab.url = next;
      session.checkConversation();
    },
  };
}

/** Masks as the content script does, with the stand-in engine. */
const maskIn = async (session: VaultSession, items: MaskItem[]) =>
  (
    await session.mask(items, (vault) =>
      issueStandIns(items, vault, {
        standIn: testEngine().standIn,
        fits: () => true,
        now: Date.now(),
      }),
    )
  ).map((standIn) => standIn.value);

const realValues = (session: VaultSession) =>
  wholeMappings(session)
    .map((mapping) => mapping.real)
    .sort();

afterEach(() => {
  for (const session of sessions.splice(0)) session.dispose();
  for (const { vault } of worlds.splice(0)) vault.close();
});

describe('vault session', () => {
  it('keeps one stand-in per value across sends and tabs', async () => {
    const w = world();
    const a = openSession(w, CONV_URL);
    const [first] = await maskIn(a.session, [DANA]);
    expect(first).toMatch(/^[a-z]+\.[a-z]+@example\.(?:org|net)$/);
    const [second, again] = await maskIn(a.session, [ROBIN, DANA]);
    expect(second).toMatch(/@example\.(?:org|net)$/);
    expect(second).not.toBe(first);
    expect(again).toBe(first);
    const b = openSession(w, CONV_URL);
    expect(await maskIn(b.session, [DANA])).toEqual([first]);
    expect(a.session.isIssued(first ?? '')).toBe(true);
    expect(a.session.isIssued((first ?? '').toUpperCase())).toBe(true);
  });

  it('shows the stored mappings after a refresh, telling the net first', async () => {
    const w = world();
    const before = openSession(w, CONV_URL);
    const [standIn] = await maskIn(before.session, [DANA]);
    before.session.dispose();

    const after = openSession(w, CONV_URL);
    await vi.waitFor(() => {
      expect(after.session.state().status).toBe('ready');
    });
    expect(wholeMappings(after.session)).toEqual([
      {
        standIn,
        real: DANA.value,
        boundary: 'email',
        // What the request safety net looks for.
        netForms: ['danawhitfieldexamplecom'],
        // Names the type in notices about stopped requests.
        entity: 'EMAIL',
      },
    ]);
    expect(after.log).toEqual(['net 1', 'source 1']);
  });

  it('masks more than 200 values in batches of 200', async () => {
    const w = world();
    const sizes: number[] = [];
    const s = openSession(w, CONV_URL, (send) => (name, request, options) => {
      if (name === 'vault.prepare' && 'items' in request) {
        sizes.push(request.items.length);
      }
      return send(name, request, options);
    });
    const items = Array.from({ length: 450 }, (_, i) =>
      email(`person.${i.toString()}`),
    );
    const standIns = await maskIn(s.session, items);
    expect(sizes).toEqual([200, 200, 50]);
    expect(new Set(standIns).size).toBe(450);
    // Order is kept across batches.
    const byReal = new Map(
      wholeMappings(s.session).map((m) => [m.real, m.standIn]),
    );
    expect(items.map((item) => byReal.get(item.value))).toEqual(standIns);
    // 450 values prepared, generated and stored one by one in
    // fake-indexeddb under jsdom: about 5 s on the target laptop.
  }, 20_000);

  it('fails the whole send when one batch fails', async () => {
    const w = world();
    let masks = 0;
    const s = openSession(w, CONV_URL, (send) => (name, request, options) => {
      if (name === 'vault.prepare') {
        masks += 1;
        if (masks === 2)
          return Promise.resolve({ ok: false, error: 'timeout' });
      }
      return send(name, request, options);
    });
    const items = Array.from({ length: 250 }, (_, i) =>
      email(`person.${i.toString()}`),
    );
    await expect(maskIn(s.session, items)).rejects.toBeInstanceOf(
      VaultSessionError,
    );
    // Nothing of the failed send is shown as issued.
    expect(wholeMappings(s.session)).toEqual([]);
  });

  it('rejects on every kind of vault failure', async () => {
    const w = world();
    // Messaging failures, a vault error, and a reply that does not match.
    const failures: ((value: object) => void)[] = [
      (value) => Object.assign(value, { status: 'error', code: 'quota' }),
      (value) => Object.assign(value, { status: 'keys-lost' }),
      (value) => Object.assign(value, { items: [] }),
    ];
    for (const error of ['no-receiver', 'context-invalidated'] as const) {
      const s = openSession(
        w,
        CONV_URL,
        (send) => (name, request, options) =>
          name === 'vault.prepare'
            ? Promise.resolve({ ok: false, error })
            : send(name, request, options),
      );
      await expect(maskIn(s.session, [DANA])).rejects.toBeInstanceOf(
        VaultSessionError,
      );
    }
    for (const change of failures) {
      const s = openSession(
        w,
        CONV_URL,
        (send) => async (name, request, options) => {
          const result = await send(name, request, options);
          if (name === 'vault.prepare' && result.ok) change(result.value);
          return result;
        },
      );
      await expect(maskIn(s.session, [DANA])).rejects.toBeInstanceOf(
        VaultSessionError,
      );
    }
  });

  it('rejects when storing the stand-ins fails, showing none of them', async () => {
    const w = world();
    const s = openSession(
      w,
      CONV_URL,
      (send) => (name, request, options) =>
        name === 'vault.commit'
          ? Promise.resolve({ ok: false, error: 'timeout' })
          : send(name, request, options),
    );
    await expect(maskIn(s.session, [DANA])).rejects.toBeInstanceOf(
      VaultSessionError,
    );
    expect(wholeMappings(s.session)).toEqual([]);
  });

  it('moves a new chat to the ID it receives and keeps its stand-ins', async () => {
    const w = world();
    const s = openSession(w, NEW_CHAT);
    const watcher = openSession(w, CONV_URL);
    const [standIn] = await maskIn(s.session, [DANA]);
    // The pending chat is this tab's own: no other tab hears of it.
    expect(w.ext.sentToTabs).toEqual([]);

    s.navigate(CONV_URL);
    expect(wholeMappings(s.session)).toHaveLength(1);
    expect(await maskIn(s.session, [DANA])).toEqual([standIn]);
    expect(s.requests).toContain('vault.migrate');
    await vi.waitFor(() => {
      expect(realValues(watcher.session)).toEqual([DANA.value]);
    });

    // A later page load of the conversation finds it.
    const reloaded = openSession(w, CONV_URL);
    await vi.waitFor(() => {
      expect(realValues(reloaded.session)).toEqual([DANA.value]);
    });
  });

  it('does not migrate a new chat that never masked anything', async () => {
    const w = world();
    const s = openSession(w, NEW_CHAT);
    s.navigate(CONV_URL);
    await maskIn(s.session, [DANA]);
    expect(s.requests).not.toContain('vault.migrate');
  });

  it('retries a failed migration before the next send and blocks it while it fails', async () => {
    const w = world();
    let failMigrations = 2;
    const s = openSession(w, NEW_CHAT, (send) => (name, request, options) => {
      if (name === 'vault.migrate' && failMigrations > 0) {
        failMigrations -= 1;
        return Promise.resolve({ ok: false, error: 'timeout' });
      }
      return send(name, request, options);
    });
    const [standIn] = await maskIn(s.session, [DANA]);
    s.navigate(CONV_URL);
    // First retry (the one queued at navigation failed) fails too.
    await expect(maskIn(s.session, [DANA])).rejects.toBeInstanceOf(
      VaultSessionError,
    );
    expect(await maskIn(s.session, [DANA])).toEqual([standIn]);
    expect(s.requests.filter((name) => name === 'vault.migrate')).toHaveLength(
      3,
    );
  });

  it('starts a new chat empty, with its own pending ID', async () => {
    const w = world();
    const s = openSession(w, CONV_URL);
    const [inConversation] = await maskIn(s.session, [DANA]);
    s.navigate(NEW_CHAT);
    expect(wholeMappings(s.session)).toEqual([]);
    expect(s.session.isIssued(inConversation ?? '')).toBe(false);
    const [inNewChat] = await maskIn(s.session, [DANA]);
    expect(inNewChat).not.toBe(inConversation);

    // The new chat receives its ID and keeps its stand-in.
    s.navigate(`https://chatgpt.com/c/${THIRD_ID}`);
    expect(wholeMappings(s.session).map((m) => m.standIn)).toEqual([inNewChat]);

    // Switching between named conversations loads each one's mappings.
    s.navigate(OTHER_URL);
    expect(wholeMappings(s.session)).toEqual([]);
    s.navigate(CONV_URL);
    await vi.waitFor(() => {
      expect(wholeMappings(s.session).map((m) => m.standIn)).toEqual([
        inConversation,
      ]);
    });
  });

  it('loads what another tab adds to the conversation', async () => {
    const w = world();
    const a = openSession(w, CONV_URL);
    const b = openSession(w, CONV_URL);
    await maskIn(b.session, [ROBIN]);
    await vi.waitFor(() => {
      expect(realValues(a.session)).toEqual([ROBIN.value]);
    });
    // A tab on another conversation does not load it.
    const c = openSession(w, OTHER_URL);
    await maskIn(b.session, [DANA]);
    await vi.waitFor(() => {
      expect(realValues(a.session)).toHaveLength(2);
    });
    expect(wholeMappings(c.session)).toEqual([]);
  });

  it('drops the values when its conversation is deleted', async () => {
    const w = world();
    const s = openSession(w, CONV_URL);
    await maskIn(s.session, [DANA]);
    s.session.handleNotice({
      name: 'vault.dropped',
      conversationIds: ['chatgpt:another-conv'],
    });
    expect(wholeMappings(s.session)).toHaveLength(1);
    s.session.handleNotice({
      name: 'vault.dropped',
      conversationIds: [`chatgpt:${CONV_ID}`],
    });
    expect(wholeMappings(s.session)).toEqual([]);
    await maskIn(s.session, [DANA]);
    s.session.handleNotice({ name: 'vault.dropped', conversationIds: 'all' });
    expect(wholeMappings(s.session)).toEqual([]);
    expect(s.session.state().status).toBe('empty');
  });

  it('forgets the values while the page is hidden and loads them when shown', async () => {
    const w = world();
    const s = openSession(w, CONV_URL);
    await maskIn(s.session, [DANA]);
    s.session.clear();
    expect(wholeMappings(s.session)).toEqual([]);
    s.session.resume();
    await vi.waitFor(() => {
      expect(realValues(s.session)).toEqual([DANA.value]);
    });

    // A new chat's own pending mappings come back too.
    const chat = openSession(w, NEW_CHAT);
    await maskIn(chat.session, [ROBIN]);
    chat.session.clear();
    chat.session.resume();
    await vi.waitFor(() => {
      expect(realValues(chat.session)).toEqual([ROBIN.value]);
    });
  });

  it('blocks a send whose conversation changed while it was masked', async () => {
    const w = world();
    let navigateDuringMask: (() => void) | null = null;
    const s = openSession(
      w,
      CONV_URL,
      (send) => async (name, request, options) => {
        const result = await send(name, request, options);
        if (name === 'vault.prepare') navigateDuringMask?.();
        return result;
      },
    );
    navigateDuringMask = () => {
      s.navigate(OTHER_URL);
    };
    await expect(maskIn(s.session, [DANA])).rejects.toBeInstanceOf(
      VaultSessionError,
    );
  });

  it('reports lost keys and blocks sends', async () => {
    const w = world();
    const s = openSession(w, CONV_URL);
    await maskIn(s.session, [DANA]);
    w.vault.close();
    const raw = await openV1(w.factory);
    await clearRaw(raw, STORE.keys);
    raw.close();
    const after = openSession(w, CONV_URL);
    await vi.waitFor(() => {
      expect(after.session.state().status).toBe('keys-lost');
    });
    await expect(maskIn(after.session, [DANA])).rejects.toBeInstanceOf(
      VaultSessionError,
    );
  });

  it('refuses work after it is disposed', async () => {
    const w = world();
    const s = openSession(w, CONV_URL);
    await maskIn(s.session, [DANA]);
    s.session.dispose();
    expect(wholeMappings(s.session)).toEqual([]);
    await expect(maskIn(s.session, [DANA])).rejects.toBeInstanceOf(
      VaultSessionError,
    );
  });
});

describe('looking values up while the user types', () => {
  /** Requests made since `from`, by name. */
  const since = (requests: string[], from: number) => requests.slice(from);

  it('a Send after a peek needs only the commit', async () => {
    const w = world();
    const s = openSession(w, CONV_URL);
    const [stored] = await maskIn(s.session, [DANA]);
    await s.session.peek([DANA, ROBIN]);
    const from = s.requests.length;
    const [dana, robin] = await maskIn(s.session, [DANA, ROBIN]);
    expect(since(s.requests, from)).toEqual(['vault.commit']);
    expect(dana).toBe(stored);
    expect(robin).toMatch(/@example\.(?:org|net)$/u);
    expect(robin).not.toBe(stored);
    // Peeking values already looked up asks for nothing.
    const again = s.requests.length;
    await s.session.peek([DANA, ROBIN]);
    expect(since(s.requests, again)).toEqual([]);
  });

  it('a peek stores nothing', async () => {
    const w = world();
    const s = openSession(w, CONV_URL);
    await s.session.peek([DANA]);
    const reloaded = openSession(w, CONV_URL);
    await vi.waitFor(() => {
      expect(reloaded.session.state().status).toBe('ready');
    });
    expect(wholeMappings(reloaded.session)).toEqual([]);
  });

  it('prepares what the peek did not cover, and a new chat on its first send', async () => {
    const w = world();
    const s = openSession(w, NEW_CHAT);
    // The pending chat does not exist yet: its date offset is unknown.
    await s.session.peek([DANA]);
    let from = s.requests.length;
    await maskIn(s.session, [DANA]);
    expect(since(s.requests, from)).toEqual(['vault.prepare', 'vault.commit']);
    // An edited draft: a value the peek has not seen.
    await s.session.peek([DANA]);
    from = s.requests.length;
    await maskIn(s.session, [DANA, ROBIN]);
    expect(since(s.requests, from)).toEqual(['vault.prepare', 'vault.commit']);
  });

  it('drops looked-up values when the conversation, the vault or the page changes', async () => {
    const w = world();
    const s = openSession(w, CONV_URL);
    const other = openSession(w, CONV_URL);
    await maskIn(s.session, [DANA]);
    const prepares = () =>
      s.requests.filter((n) => n === 'vault.prepare').length;

    // Another tab stores a value in this conversation.
    await s.session.peek([DANA]);
    await maskIn(other.session, [ROBIN]);
    await vi.waitFor(() => {
      expect(realValues(s.session)).toHaveLength(2);
    });
    let before = prepares();
    await maskIn(s.session, [DANA]);
    expect(prepares()).toBe(before + 1);

    // The page is hidden.
    await s.session.peek([DANA]);
    s.session.clear();
    before = prepares();
    await maskIn(s.session, [DANA]);
    expect(prepares()).toBe(before + 1);

    // Another conversation.
    await s.session.peek([DANA]);
    s.navigate(OTHER_URL);
    s.navigate(CONV_URL);
    before = prepares();
    await maskIn(s.session, [DANA]);
    expect(prepares()).toBe(before + 1);

    // Values deleted.
    await s.session.peek([DANA]);
    s.session.handleNotice({ name: 'vault.dropped', conversationIds: 'all' });
    before = prepares();
    await maskIn(s.session, [DANA]);
    expect(prepares()).toBe(before + 1);
  });

  it('looks values up again when a reused one was deleted unnoticed', async () => {
    const w = world();
    const s = openSession(w, CONV_URL);
    const [first] = await maskIn(s.session, [DANA]);
    await s.session.peek([DANA]);
    // The mapping disappears without a notice reaching this tab.
    const raw = await openV1(w.factory);
    await clearRaw(raw, STORE.mappings);
    raw.close();
    const from = s.requests.length;
    const [second] = await maskIn(s.session, [DANA]);
    expect(since(s.requests, from)).toEqual([
      'vault.commit',
      'vault.prepare',
      'vault.commit',
    ]);
    // Stored again: the same seed gives the same stand-in (TR-S1).
    expect(second).toBe(first);
  });

  it('a failed peek leaves the next Send working', async () => {
    const w = world();
    const s = openSession(
      w,
      CONV_URL,
      (send) => (name, request, options) =>
        name === 'vault.peek'
          ? Promise.resolve({ ok: false, error: 'timeout' })
          : send(name, request, options),
    );
    await expect(s.session.peek([DANA])).rejects.toBeInstanceOf(
      VaultSessionError,
    );
    expect(await maskIn(s.session, [DANA])).toHaveLength(1);
  });
});

describe('vault session in the page', () => {
  const readyNet = (synced: number[]): NetBridge => ({
    isReady: () => true,
    onReady: (callback) => {
      callback();
    },
    setVerifier: () => undefined,
    onVerdict: () => undefined,
    onReport: () => undefined,
    valueOfForm: () => null,
    hashForm: (form: string) => form,
    sync: (mappings) => {
      synced.push(mappings.length);
    },
  });

  function startPage(w: World, wrap?: (send: Send) => Send) {
    const h = setUpPage();
    const s = openSession(w, CONV_URL, wrap);
    const masker = createPipeline({
      detect: detectEmailsOnly,
      normalise: (detection) => detection.value.toLowerCase(),
      engine: () => Promise.resolve(testEngine()),
      mask: (items, issue) => s.session.mask(items, issue),
      isIssued: (value) => s.session.isIssued(value),
      entityTypes: () => new Set(['EMAIL']),
    });
    const controller = new AbortController();
    const synced: number[] = [];
    startInstance({
      adapter: h.adapter,
      transform: masker.transform,
      source: s.session.source,
      net: readyNet(synced),
      isContextValid: () => true,
      signal: controller.signal,
    });
    return { h, s, controller, synced };
  }

  it('sends the vault stand-in', async () => {
    const w = world();
    const { h, controller } = startPage(w);
    h.editor.textContent = `Mail ${DANA.value}`;
    pressKey(h.editor, { key: 'Enter' });
    await vi.waitFor(() => {
      expect(h.siteSends).toHaveLength(1);
    });
    expect(h.siteSends[0]).toMatch(
      /^Mail [a-z]+\.[a-z]+@example\.(?:org|net)$/,
    );
    controller.abort();
  });

  it('blocks the send and keeps the prompt when the vault fails', async () => {
    const w = world();
    const { h, controller } = startPage(
      w,
      (send) => (name, request, options) =>
        name === 'vault.prepare'
          ? Promise.resolve({ ok: false, error: 'timeout' })
          : send(name, request, options),
    );
    h.editor.textContent = `Mail ${DANA.value}`;
    const enter = pressKey(h.editor, { key: 'Enter' });
    expect(enter.defaultPrevented).toBe(true);
    await flush();
    await flush();
    expect(h.siteSends).toEqual([]);
    expect(h.editor.textContent).toBe(`Mail ${DANA.value}`);
    controller.abort();
  });
});
