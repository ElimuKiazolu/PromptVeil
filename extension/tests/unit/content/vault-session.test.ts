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
import { createSpikeMasker } from '@/src/core/spike-mask.ts';
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
      log.push(`net ${mappings.length.toString()}`);
    },
    randomUUID: () => crypto.randomUUID(),
  });
  session.source.subscribe(() => {
    log.push(`source ${session.source.mappings().length.toString()}`);
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

const realValues = (session: VaultSession) =>
  session.source
    .mappings()
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
    const [first] = await a.session.mask([DANA]);
    expect(first).toMatch(/^standin\.1\.[a-z0-9]{4}@example\.net$/);
    expect(await a.session.mask([ROBIN, DANA])).toEqual([
      expect.stringMatching(/^standin\.2\./),
      first,
    ]);
    const b = openSession(w, CONV_URL);
    expect(await b.session.mask([DANA])).toEqual([first]);
    expect(a.session.isIssued(first ?? '')).toBe(true);
    expect(a.session.isIssued((first ?? '').toUpperCase())).toBe(true);
  });

  it('shows the stored mappings after a refresh, telling the net first', async () => {
    const w = world();
    const before = openSession(w, CONV_URL);
    const [standIn] = await before.session.mask([DANA]);
    before.session.dispose();

    const after = openSession(w, CONV_URL);
    await vi.waitFor(() => {
      expect(after.session.state().status).toBe('ready');
    });
    expect(after.session.source.mappings()).toEqual([
      { standIn, real: DANA.value, boundary: 'email' },
    ]);
    expect(after.log).toEqual(['net 1', 'source 1']);
  });

  it('masks more than 200 values in batches of 200', async () => {
    const w = world();
    const sizes: number[] = [];
    const s = openSession(w, CONV_URL, (send) => (name, request, options) => {
      if (name === 'vault.mask' && 'items' in request) {
        sizes.push(request.items.length);
      }
      return send(name, request, options);
    });
    const items = Array.from({ length: 450 }, (_, i) =>
      email(`person.${i.toString()}`),
    );
    const standIns = await s.session.mask(items);
    expect(sizes).toEqual([200, 200, 50]);
    expect(new Set(standIns).size).toBe(450);
    // Order is kept across batches.
    const byReal = new Map(
      s.session.source.mappings().map((m) => [m.real, m.standIn]),
    );
    expect(items.map((item) => byReal.get(item.value))).toEqual(standIns);
  });

  it('fails the whole send when one batch fails', async () => {
    const w = world();
    let masks = 0;
    const s = openSession(w, CONV_URL, (send) => (name, request, options) => {
      if (name === 'vault.mask') {
        masks += 1;
        if (masks === 2)
          return Promise.resolve({ ok: false, error: 'timeout' });
      }
      return send(name, request, options);
    });
    const items = Array.from({ length: 250 }, (_, i) =>
      email(`person.${i.toString()}`),
    );
    await expect(s.session.mask(items)).rejects.toBeInstanceOf(
      VaultSessionError,
    );
    // Nothing of the failed send is shown as issued.
    expect(s.session.source.mappings()).toEqual([]);
  });

  it('rejects on every kind of vault failure', async () => {
    const w = world();
    // Messaging failures, a vault error, and a reply that does not match.
    const failures: ((value: object) => void)[] = [
      (value) => Object.assign(value, { status: 'error', code: 'quota' }),
      (value) => Object.assign(value, { status: 'keys-lost' }),
      (value) => Object.assign(value, { standIns: [] }),
    ];
    for (const error of ['no-receiver', 'context-invalidated'] as const) {
      const s = openSession(
        w,
        CONV_URL,
        (send) => (name, request, options) =>
          name === 'vault.mask'
            ? Promise.resolve({ ok: false, error })
            : send(name, request, options),
      );
      await expect(s.session.mask([DANA])).rejects.toBeInstanceOf(
        VaultSessionError,
      );
    }
    for (const change of failures) {
      const s = openSession(
        w,
        CONV_URL,
        (send) => async (name, request, options) => {
          const result = await send(name, request, options);
          if (name === 'vault.mask' && result.ok) change(result.value);
          return result;
        },
      );
      await expect(s.session.mask([DANA])).rejects.toBeInstanceOf(
        VaultSessionError,
      );
    }
  });

  it('moves a new chat to the ID it receives and keeps its stand-ins', async () => {
    const w = world();
    const s = openSession(w, NEW_CHAT);
    const watcher = openSession(w, CONV_URL);
    const [standIn] = await s.session.mask([DANA]);
    // The pending chat is this tab's own: no other tab hears of it.
    expect(w.ext.sentToTabs).toEqual([]);

    s.navigate(CONV_URL);
    expect(s.session.source.mappings()).toHaveLength(1);
    expect(await s.session.mask([DANA])).toEqual([standIn]);
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
    await s.session.mask([DANA]);
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
    const [standIn] = await s.session.mask([DANA]);
    s.navigate(CONV_URL);
    // First retry (the one queued at navigation failed) fails too.
    await expect(s.session.mask([DANA])).rejects.toBeInstanceOf(
      VaultSessionError,
    );
    expect(await s.session.mask([DANA])).toEqual([standIn]);
    expect(s.requests.filter((name) => name === 'vault.migrate')).toHaveLength(
      3,
    );
  });

  it('starts a new chat empty, with its own pending ID', async () => {
    const w = world();
    const s = openSession(w, CONV_URL);
    const [inConversation] = await s.session.mask([DANA]);
    s.navigate(NEW_CHAT);
    expect(s.session.source.mappings()).toEqual([]);
    expect(s.session.isIssued(inConversation ?? '')).toBe(false);
    const [inNewChat] = await s.session.mask([DANA]);
    expect(inNewChat).not.toBe(inConversation);

    // The new chat receives its ID and keeps its stand-in.
    s.navigate(`https://chatgpt.com/c/${THIRD_ID}`);
    expect(s.session.source.mappings().map((m) => m.standIn)).toEqual([
      inNewChat,
    ]);

    // Switching between named conversations loads each one's mappings.
    s.navigate(OTHER_URL);
    expect(s.session.source.mappings()).toEqual([]);
    s.navigate(CONV_URL);
    await vi.waitFor(() => {
      expect(s.session.source.mappings().map((m) => m.standIn)).toEqual([
        inConversation,
      ]);
    });
  });

  it('loads what another tab adds to the conversation', async () => {
    const w = world();
    const a = openSession(w, CONV_URL);
    const b = openSession(w, CONV_URL);
    await b.session.mask([ROBIN]);
    await vi.waitFor(() => {
      expect(realValues(a.session)).toEqual([ROBIN.value]);
    });
    // A tab on another conversation does not load it.
    const c = openSession(w, OTHER_URL);
    await b.session.mask([DANA]);
    await vi.waitFor(() => {
      expect(realValues(a.session)).toHaveLength(2);
    });
    expect(c.session.source.mappings()).toEqual([]);
  });

  it('drops the values when its conversation is deleted', async () => {
    const w = world();
    const s = openSession(w, CONV_URL);
    await s.session.mask([DANA]);
    s.session.handleNotice({
      name: 'vault.dropped',
      conversationIds: ['chatgpt:another-conv'],
    });
    expect(s.session.source.mappings()).toHaveLength(1);
    s.session.handleNotice({
      name: 'vault.dropped',
      conversationIds: [`chatgpt:${CONV_ID}`],
    });
    expect(s.session.source.mappings()).toEqual([]);
    await s.session.mask([DANA]);
    s.session.handleNotice({ name: 'vault.dropped', conversationIds: 'all' });
    expect(s.session.source.mappings()).toEqual([]);
    expect(s.session.state().status).toBe('empty');
  });

  it('forgets the values while the page is hidden and loads them when shown', async () => {
    const w = world();
    const s = openSession(w, CONV_URL);
    await s.session.mask([DANA]);
    s.session.clear();
    expect(s.session.source.mappings()).toEqual([]);
    s.session.resume();
    await vi.waitFor(() => {
      expect(realValues(s.session)).toEqual([DANA.value]);
    });

    // A new chat's own pending mappings come back too.
    const chat = openSession(w, NEW_CHAT);
    await chat.session.mask([ROBIN]);
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
        if (name === 'vault.mask') navigateDuringMask?.();
        return result;
      },
    );
    navigateDuringMask = () => {
      s.navigate(OTHER_URL);
    };
    await expect(s.session.mask([DANA])).rejects.toBeInstanceOf(
      VaultSessionError,
    );
  });

  it('reports lost keys and blocks sends', async () => {
    const w = world();
    const s = openSession(w, CONV_URL);
    await s.session.mask([DANA]);
    w.vault.close();
    const raw = await openV1(w.factory);
    await clearRaw(raw, STORE.keys);
    raw.close();
    const after = openSession(w, CONV_URL);
    await vi.waitFor(() => {
      expect(after.session.state().status).toBe('keys-lost');
    });
    await expect(after.session.mask([DANA])).rejects.toBeInstanceOf(
      VaultSessionError,
    );
  });

  it('refuses work after it is disposed', async () => {
    const w = world();
    const s = openSession(w, CONV_URL);
    await s.session.mask([DANA]);
    s.session.dispose();
    expect(s.session.source.mappings()).toEqual([]);
    await expect(s.session.mask([DANA])).rejects.toBeInstanceOf(
      VaultSessionError,
    );
  });
});

describe('vault session in the page', () => {
  const readyNet = (synced: number[]): NetBridge => ({
    isReady: () => true,
    onReady: (callback) => {
      callback();
    },
    sync: (mappings) => {
      synced.push(mappings.length);
    },
  });

  function startPage(w: World, wrap?: (send: Send) => Send) {
    const h = setUpPage();
    const s = openSession(w, CONV_URL, wrap);
    const masker = createSpikeMasker({
      detect: detectEmailsOnly,
      normalise: (detection) => detection.value.toLowerCase(),
      issue: (items) => s.session.mask(items),
      isIssued: (value) => s.session.isIssued(value),
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
      /^Mail standin\.1\.[a-z0-9]{4}@example\.net$/,
    );
    controller.abort();
  });

  it('blocks the send and keeps the prompt when the vault fails', async () => {
    const w = world();
    const { h, controller } = startPage(
      w,
      (send) => (name, request, options) =>
        name === 'vault.mask'
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
