import { IDBFactory } from 'fake-indexeddb';
import { afterEach, describe, expect, it } from 'vitest';
import { senderSite } from '@/src/background/sites.ts';
import { registerVaultHandlers } from '@/src/background/vault-host.ts';
import { STORE } from '@/src/core/vault/schema.ts';
import {
  createVaultService,
  type VaultService,
} from '@/src/core/vault/service.ts';
import {
  createMessenger,
  listenForNotices,
  PROTOCOL,
  type Messenger,
  type Protocol,
} from '@/src/shared/messaging.ts';
import {
  isVaultNotice,
  type MaskItem,
  type VaultNotice,
} from '@/src/shared/vault-protocol.ts';
import { clearRaw, openV1, webCrypto } from '../core/vault/harness.ts';
import {
  EXTENSION_ID,
  FakeExtension,
  type FakeTab,
} from '../extension-fakes.ts';

const CONV_ID = '6800a1b2-c3d4-4e5f-8a9b-0c1d2e3f4a5b';
const CONV = `chatgpt:${CONV_ID}`;
const PENDING = 'chatgpt:pending:6f1c2a4e-8b3d-4c5e-9f7a-1b2c3d4e5f60';
const URL_CONV = `https://chatgpt.com/c/${CONV_ID}`;

// Fixture identity address (example.com is reserved for documentation).
const DANA: MaskItem = {
  type: 'EMAIL',
  subtype: null,
  country: null,
  value: 'Dana.Whitfield@example.com',
  normalised: 'dana.whitfield@example.com',
};

const ROBIN: MaskItem = {
  ...DANA,
  value: 'robin.hale@example.org',
  normalised: 'robin.hale@example.org',
};

interface Setup {
  ext: FakeExtension;
  vault: VaultService;
  factory: IDBFactory;
  client: (tab: FakeTab) => Messenger<Protocol>;
  notices: (tab: FakeTab) => VaultNotice[];
}

const vaults: VaultService[] = [];

function setUp(): Setup {
  const ext = new FakeExtension();
  const factory = new IDBFactory();
  const vault = createVaultService({ idb: factory, crypto: webCrypto });
  vaults.push(vault);
  registerVaultHandlers({
    messenger: createMessenger(PROTOCOL, ext.background),
    vault,
    tabs: ext.tabs,
  });
  return {
    ext,
    vault,
    factory,
    client: (tab) => createMessenger(PROTOCOL, tab.runtime),
    notices: (tab) => {
      const received: VaultNotice[] = [];
      listenForNotices(tab.runtime, isVaultNotice, (notice) => {
        received.push(notice);
      });
      return received;
    },
  };
}

let issuedCount = 0;

/**
 * Masks as the content script does: prepare, a numbered stand-in for each
 * new value, commit. Returns the stand-ins.
 */
async function maskVia(
  tab: Messenger<Protocol>,
  conversationId: string,
  items: MaskItem[],
): Promise<string[]> {
  const prepared = await tab.send('vault.prepare', { conversationId, items });
  if (!prepared.ok || prepared.value.status !== 'ok') {
    throw new Error('not prepared');
  }
  const standIns: string[] = [];
  for (const [index, value] of prepared.value.items.entries()) {
    const item = items[index];
    if (item === undefined) throw new Error('missing item');
    if (value.kind === 'existing') {
      standIns.push(value.standIn);
      continue;
    }
    // Unique across conversations, so a migration never meets a clash.
    issuedCount += 1;
    const standIn = `standin.${issuedCount.toString()}.test@example.net`;
    const committed = await tab.send('vault.commit', {
      conversationId,
      entries: [{ item, standIn, standInNormalised: standIn }],
    });
    if (!committed.ok || committed.value.status !== 'ok') {
      throw new Error('not committed');
    }
    const [outcome] = committed.value.items;
    if (outcome === undefined || outcome.kind === 'taken') {
      throw new Error('taken');
    }
    standIns.push(outcome.standIn);
  }
  return standIns;
}

const entry = (item: MaskItem, standIn: string) => ({
  item,
  standIn,
  standInNormalised: standIn,
});

/** Lets fire-and-forget notices arrive. */
const settle = () =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });

afterEach(() => {
  for (const vault of vaults.splice(0)) vault.close();
});

describe('sender checks', () => {
  it('accepts only the top frame of a tab on a vault site', () => {
    const base = { id: EXTENSION_ID, tab: { id: 3 }, frameId: 0 };
    expect(senderSite({ ...base, url: URL_CONV })).toBe('chatgpt');
    expect(senderSite({ ...base, url: 'https://chatgpt.com/' })).toBe(
      'chatgpt',
    );
    expect(senderSite({ ...base, frameId: 2, url: URL_CONV })).toBeNull();
    expect(senderSite({ id: EXTENSION_ID, frameId: 0, url: URL_CONV })).toBe(
      null,
    );
    expect(senderSite({ ...base, url: 'http://chatgpt.com/' })).toBeNull();
    expect(senderSite({ ...base, url: 'https://chatgpt.com.example/' })).toBe(
      null,
    );
    expect(senderSite({ ...base, url: 'https://claude.ai/chat/x' })).toBeNull();
    expect(senderSite({ ...base, url: 'not a url' })).toBeNull();
    expect(senderSite(base)).toBeNull();
  });

  it('refuses conversations of another site, malformed IDs and wrong frames', async () => {
    const { ext, client } = setUp();
    const tab = client(ext.openTab(URL_CONV));
    const iframe = client(ext.openTab(URL_CONV, { frameId: 1 }));
    const other = client(ext.openTab('https://example.com/c/x'));
    const forbidden = { status: 'error', code: 'forbidden' };

    for (const conversationId of [
      'gemini:abc12345',
      'claude:abc12345',
      'chatgpt:short',
      'chatgpt:pending:not-a-uuid',
      'chatgpt:has space in id',
      CONV_ID,
    ]) {
      expect(
        await tab.send('vault.prepare', { conversationId, items: [DANA] }),
      ).toEqual({ ok: true, value: forbidden });
      expect(
        await tab.send('vault.commit', {
          conversationId,
          entries: [entry(DANA, 'standin.1@example.net')],
        }),
      ).toEqual({ ok: true, value: forbidden });
      expect(await tab.send('vault.load', { conversationId })).toEqual({
        ok: true,
        value: forbidden,
      });
    }
    for (const client of [iframe, other]) {
      expect(
        await client.send('vault.prepare', {
          conversationId: CONV,
          items: [DANA],
        }),
      ).toEqual({ ok: true, value: forbidden });
      expect(
        await client.send('vault.commit', {
          conversationId: CONV,
          entries: [entry(DANA, 'standin.1@example.net')],
        }),
      ).toEqual({ ok: true, value: forbidden });
      expect(await client.send('vault.load', { conversationId: CONV })).toEqual(
        { ok: true, value: forbidden },
      );
    }
  });

  it('migrates only from a pending chat to a named conversation', async () => {
    const { ext, client } = setUp();
    const tab = client(ext.openTab(URL_CONV));
    const forbidden = {
      ok: true,
      value: { status: 'error', code: 'forbidden' },
    };
    expect(
      await tab.send('vault.migrate', { from: CONV, to: PENDING }),
    ).toEqual(forbidden);
    expect(await tab.send('vault.migrate', { from: CONV, to: CONV })).toEqual(
      forbidden,
    );
    expect(
      await tab.send('vault.migrate', {
        from: PENDING,
        to: 'chatgpt:pending:0f1c2a4e-8b3d-4c5e-9f7a-1b2c3d4e5f60',
      }),
    ).toEqual(forbidden);
    expect(
      await tab.send('vault.migrate', { from: PENDING, to: 'gemini:abc12345' }),
    ).toEqual(forbidden);
    expect(
      await tab.send('vault.migrate', { from: PENDING, to: CONV }),
    ).toEqual({ ok: true, value: { status: 'nothing' } });
  });

  it('rejects requests of the wrong shape, including more than 200 items', async () => {
    const { ext, client } = setUp();
    const tab = client(ext.openTab(URL_CONV));
    expect(
      await tab.send('vault.prepare', {
        conversationId: CONV,
        items: Array.from({ length: 201 }, () => DANA),
      }),
    ).toEqual({ ok: false, error: 'rejected' });
    expect(
      await tab.send('vault.prepare', { conversationId: CONV, items: [] }),
    ).toEqual({ ok: false, error: 'rejected' });
    expect(
      await tab.send('vault.prepare', {
        conversationId: CONV,
        items: [{ ...DANA, normalised: '' }],
      }),
    ).toEqual({ ok: false, error: 'rejected' });
    expect(
      await tab.send('vault.commit', {
        conversationId: CONV,
        entries: Array.from({ length: 201 }, () =>
          entry(DANA, 'standin.1@example.net'),
        ),
      }),
    ).toEqual({ ok: false, error: 'rejected' });
    expect(
      await tab.send('vault.commit', {
        conversationId: CONV,
        entries: [{ ...entry(DANA, 'standin.1@example.net'), standIn: '' }],
      }),
    ).toEqual({ ok: false, error: 'rejected' });
  });
});

describe('vault requests', () => {
  it('masks, reuses and loads a conversation for the asking tab', async () => {
    const { ext, client } = setUp();
    const tab = client(ext.openTab(URL_CONV));
    const prepared = await tab.send('vault.prepare', {
      conversationId: CONV,
      items: [DANA],
    });
    if (!prepared.ok || prepared.value.status !== 'ok') {
      throw new Error('not prepared');
    }
    // A seed of 32 bytes (base64) and the conversation's date offset.
    const [first] = prepared.value.items;
    if (first?.kind !== 'new') throw new Error('expected a new value');
    expect(first.seed).toMatch(/^[A-Za-z0-9+/]{43}=$/u);
    expect(first.number).toBe(1);
    expect(Math.abs(prepared.value.dateOffsetDays)).toBeGreaterThanOrEqual(30);
    const [standIn = ''] = await maskVia(tab, CONV, [DANA]);
    expect(
      await tab.send('vault.prepare', {
        conversationId: CONV,
        items: [{ ...DANA, value: 'dana.whitfield@EXAMPLE.com' }],
      }),
    ).toEqual({
      ok: true,
      value: {
        status: 'ok',
        dateOffsetDays: prepared.value.dateOffsetDays,
        items: [{ kind: 'existing', standIn }],
      },
    });
    // A stand-in used for one value is taken for another.
    expect(
      await tab.send('vault.commit', {
        conversationId: CONV,
        entries: [entry(ROBIN, standIn)],
      }),
    ).toEqual({
      ok: true,
      value: { status: 'ok', items: [{ kind: 'taken' }] },
    });
    expect(await tab.send('vault.load', { conversationId: CONV })).toEqual({
      ok: true,
      value: {
        status: 'ok',
        mappings: [{ standIn, real: DANA.value, type: 'EMAIL' }],
        failed: 0,
      },
    });
  });

  it('tells the other tabs when a conversation gains mappings, without values', async () => {
    const { ext, client, notices } = setUp();
    const senderTab = ext.openTab(URL_CONV);
    const otherTab = ext.openTab('https://chatgpt.com/');
    const unrelated = ext.openTab('https://example.com/');
    const toSender = notices(senderTab);
    const toOther = notices(otherTab);
    const tab = client(senderTab);

    // Preparing stores nothing: no notice yet.
    await tab.send('vault.prepare', { conversationId: CONV, items: [DANA] });
    await settle();
    expect(toOther).toEqual([]);
    await maskVia(tab, CONV, [DANA]);
    await settle();
    expect(toOther).toEqual([{ name: 'vault.changed', conversationId: CONV }]);
    expect(toSender).toEqual([]);
    expect(ext.sentToTabs.map((sent) => sent.tabId)).not.toContain(
      unrelated.id,
    );
    expect(JSON.stringify(ext.sentToTabs)).not.toContain(DANA.value);

    // A reuse adds nothing, and a pending chat is the sender's alone.
    await maskVia(tab, CONV, [DANA]);
    await maskVia(tab, PENDING, [ROBIN]);
    await settle();
    expect(toOther).toHaveLength(1);

    expect(
      await tab.send('vault.migrate', { from: PENDING, to: CONV }),
    ).toEqual({ ok: true, value: { status: 'migrated', count: 1 } });
    await settle();
    expect(toOther).toEqual([
      { name: 'vault.changed', conversationId: CONV },
      { name: 'vault.changed', conversationId: CONV },
    ]);
  });

  it('reports lost keys as a state, not an error', async () => {
    const { ext, client, vault, factory } = setUp();
    const tab = client(ext.openTab(URL_CONV));
    await maskVia(tab, CONV, [DANA]);
    vault.close();
    const raw = await openV1(factory);
    await clearRaw(raw, STORE.keys);
    raw.close();
    expect(await tab.send('vault.load', { conversationId: CONV })).toEqual({
      ok: true,
      value: { status: 'keys-lost' },
    });
    expect(
      await tab.send('vault.prepare', { conversationId: CONV, items: [DANA] }),
    ).toEqual({ ok: true, value: { status: 'keys-lost' } });
    expect(
      await tab.send('vault.commit', {
        conversationId: CONV,
        entries: [entry(ROBIN, 'standin.2@example.net')],
      }),
    ).toEqual({ ok: true, value: { status: 'keys-lost' } });
  });

  it('reports a vault failure by its code', async () => {
    const { ext, client, vault } = setUp();
    const tab = client(ext.openTab(URL_CONV));
    await maskVia(tab, CONV, [DANA]);
    // Another stand-in format cannot be forced through the protocol, so a
    // failing open stands in for any vault error.
    vault.close();
    const failing = createVaultService({
      idb: {
        open: () => {
          throw new DOMException('denied', 'SecurityError');
        },
        deleteDatabase: () => {
          throw new DOMException('denied', 'SecurityError');
        },
        cmp: () => 0,
        databases: () => Promise.resolve([]),
      },
      crypto: webCrypto,
    });
    const ext2 = new FakeExtension();
    registerVaultHandlers({
      messenger: createMessenger(PROTOCOL, ext2.background),
      vault: failing,
      tabs: ext2.tabs,
    });
    const tab2 = createMessenger(PROTOCOL, ext2.openTab(URL_CONV).runtime);
    expect(
      await tab2.send('vault.prepare', {
        conversationId: CONV,
        items: [DANA],
      }),
    ).toEqual({ ok: true, value: { status: 'error', code: 'unavailable' } });
  });
});
