import { IDBFactory } from 'fake-indexeddb';
import { afterEach, describe, expect, it } from 'vitest';
import { conversationIdFromUrl } from '@/src/adapters/chatgpt.ts';
import { registerVaultHandlers } from '@/src/background/vault-host.ts';
import {
  createVaultSession,
  type VaultSession,
} from '@/src/content/vault-session.ts';
import {
  createVaultService,
  type VaultService,
} from '@/src/core/vault/service.ts';
import { nameParts } from '@/src/core/names/parts.ts';
import { issueStandIns, type IssuedStandIn } from '@/src/core/pipeline.ts';
import { createRestoreMatcher } from '@/src/core/restore/index.ts';
import { createMessenger, PROTOCOL } from '@/src/shared/messaging.ts';
import type { CommitRequest, MaskItem } from '@/src/shared/vault-protocol.ts';
import { webCrypto } from '../core/vault/harness.ts';
import { FakeExtension } from '../extension-fakes.ts';

const CONV_URL = 'https://chatgpt.com/c/6800a1b2-c3d4-4e5f-8a9b-0c1d2e3f4a5b';

// Fixture-style names (tests/fixtures/identities.json) and made-up ones.
const person = (value: string): MaskItem => ({
  type: 'PERSON',
  subtype: null,
  country: null,
  value,
  normalised: value.toLowerCase(),
});

const services: VaultService[] = [];
const sessions: VaultSession[] = [];

afterEach(() => {
  for (const session of sessions.splice(0)) session.dispose();
  for (const service of services.splice(0)) service.close();
});

function setUp(): {
  open: () => VaultSession;
  sent: CommitRequest['entries'][];
} {
  const ext = new FakeExtension();
  const vault = createVaultService({
    idb: new IDBFactory(),
    crypto: webCrypto,
  });
  services.push(vault);
  registerVaultHandlers({
    messenger: createMessenger(PROTOCOL, ext.background),
    vault,
    tabs: ext.tabs,
  });
  const sent: CommitRequest['entries'][] = [];
  const open = (): VaultSession => {
    const tab = ext.openTab(CONV_URL);
    const messenger = createMessenger(PROTOCOL, tab.runtime);
    const session = createVaultSession({
      adapter: {
        id: 'chatgpt',
        getConversationId: () => conversationIdFromUrl(new URL(tab.url)),
      },
      messenger: {
        send: (name, request, options) => {
          if (name === 'vault.commit') {
            sent.push((request as CommitRequest).entries);
          }
          return messenger.send(name, request, options);
        },
      },
      beforePublish: () => undefined,
      randomUUID: () => crypto.randomUUID(),
    });
    sessions.push(session);
    session.checkConversation();
    return session;
  };
  return { open, sent };
}

/** Fixed stand-ins, so the parts are known. */
function maskAs(
  session: VaultSession,
  items: MaskItem[],
  standIns: string[],
): Promise<IssuedStandIn[]> {
  return session.mask(items, (vault) =>
    issueStandIns(items, vault, {
      standIn: (request) => {
        const value =
          standIns[items.findIndex((i) => i.value === request.value)] ?? '';
        return {
          value,
          normalised: value.toLowerCase(),
          reserved: false,
          locale: 'en_GB',
          parts: nameParts(value),
        };
      },
      fits: () => true,
      now: 0,
    }),
  );
}

const settle = () =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });

describe('PERSON mappings in the session', () => {
  it('restore single name parts, paired by position, when each stands for one real part', async () => {
    const { open, sent } = setUp();
    const session = open();
    await settle();
    await maskAs(
      session,
      [person('Harriet Pemberton'), person('Robin Pemberton')],
      ['Olivia Hughes', 'Ellis Hughes'],
    );
    // The parts went to the vault with the stand-ins.
    expect(sent[0]?.map((entry) => [entry.variants, entry.locale])).toEqual([
      [['Olivia', 'Hughes'], 'en_GB'],
      [['Ellis', 'Hughes'], 'en_GB'],
    ]);
    const matcher = createRestoreMatcher(session.source.mappings());
    const restore = (text: string) => {
      let out = text;
      for (const found of matcher.find(text).reverse()) {
        out = out.slice(0, found.start) + found.real + out.slice(found.end);
      }
      return out;
    };
    expect(restore('Olivia Hughes and Ellis Hughes')).toBe(
      'Harriet Pemberton and Robin Pemberton',
    );
    // "Hughes" stands for one real part (Pemberton) only.
    expect(restore('Dear Olivia, Mr Hughes and ELLIS')).toBe(
      'Dear Harriet, Mr Pemberton and ROBIN',
    );
    // Written in another case, a part is an ordinary word.
    expect(restore('olivia said')).toBe('olivia said');
    expect(
      session
        .issued()
        .map((value) => value.standIn)
        .sort(),
    ).toEqual(['Ellis Hughes', 'Olivia Hughes']);
  });

  it('skip a part that stands for two different real parts', async () => {
    const { open } = setUp();
    const session = open();
    await settle();
    await maskAs(
      session,
      [person('Harriet Pemberton'), person('Robin Hale')],
      ['Olivia Hughes', 'Ellis Hughes'],
    );
    const parts = session.source
      .mappings()
      .filter((mapping) => mapping.boundary === 'name')
      .map((mapping) => mapping.standIn)
      .sort();
    expect(parts).toEqual(['Ellis', 'Olivia']);
  });

  it('come back from the vault with their stored parts after a reload', async () => {
    const { open } = setUp();
    const first = open();
    await settle();
    await maskAs(
      first,
      [person('Dr. Harriet Pemberton')],
      ['Dr. Olivia Hughes'],
    );
    const second = open();
    for (let i = 0; i < 200 && second.state().status !== 'ready'; i += 1) {
      await settle();
    }
    expect(second.state().status).toBe('ready');
    const names = second.source
      .mappings()
      .filter((mapping) => mapping.boundary === 'name')
      .map((mapping) => [mapping.standIn, mapping.real]);
    expect(names.sort()).toEqual([
      ['Hughes', 'Pemberton'],
      ['Olivia', 'Harriet'],
    ]);
    // The request safety net checks the whole name, not single parts.
    for (const mapping of second.source.mappings()) {
      if (mapping.boundary === 'name') expect(mapping.netForms).toEqual([]);
    }
  });
});

describe('crypto mappings in the session', () => {
  it('restore a Base58 address only as written, others in any case', async () => {
    const { open } = setUp();
    const session = open();
    await settle();
    // Made-up values: the session only looks at their shape.
    const crypto = (value: string): MaskItem => ({
      type: 'CRYPTO',
      subtype: null,
      country: null,
      value,
      normalised: value,
    });
    const legacy = `1${'A'.repeat(32)}`;
    const ethereum = `0x${'ab'.repeat(20)}`;
    await maskAs(
      session,
      [crypto(`1${'B'.repeat(32)}`), crypto(`0x${'cd'.repeat(20)}`)],
      [legacy, ethereum],
    );
    const boundaries = new Map(
      session.source
        .mappings()
        .map((mapping) => [mapping.standIn, mapping.boundary]),
    );
    expect(boundaries.get(legacy)).toBe('exact');
    expect(boundaries.get(ethereum)).toBe('word');
  });
});

describe('DOB mappings in the session', () => {
  const dob: MaskItem = {
    type: 'DOB',
    subtype: null,
    country: null,
    value: '12/03/1990',
    normalised: '1990-03-12',
  };
  const maskDob = (session: VaultSession) =>
    session.mask([dob], (vault) =>
      issueStandIns([dob], vault, {
        standIn: () => ({
          value: '26/04/1990',
          normalised: '1990-04-26',
          reserved: false,
          locale: null,
          parts: ['DMY'],
        }),
        fits: () => true,
        now: 0,
      }),
    );

  it('store the order, count the stand-in date in any format as issued, and restore it after a reload', async () => {
    const { open, sent } = setUp();
    const session = open();
    await settle();
    expect(await maskDob(session)).toEqual([
      { value: '26/04/1990', variants: ['DMY'] },
    ]);
    expect(sent[0]?.map((entry) => entry.variants)).toEqual([['DMY']]);
    expect(session.isIssued('26/04/1990')).toBe(true);
    expect(session.isIssued('26 April 1990')).toBe(true);
    expect(session.isIssued('1990-04-26')).toBe(true);
    expect(session.isIssued('27 April 1990')).toBe(false);
    expect(session.isIssued('12/03/1990')).toBe(false);
    // Stored: the vault hands back the order with the stand-in.
    expect(await maskDob(session)).toEqual([
      { value: '26/04/1990', variants: ['DMY'] },
    ]);
    const reloaded = open();
    for (let i = 0; i < 200 && reloaded.state().status !== 'ready'; i += 1) {
      await settle();
    }
    expect(reloaded.state().status).toBe('ready');
    const matcher = createRestoreMatcher(reloaded.source.mappings());
    const [found] = matcher.find('Born April 26, 1990.');
    expect(found?.real).toBe('March 12, 1990');
  });
});
