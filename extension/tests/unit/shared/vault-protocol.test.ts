import { describe, expect, it } from 'vitest';
import {
  activeConversationId,
  isSiteConversationId,
  parseConversationId,
  pendingConversationId,
} from '@/src/shared/conversation-id.ts';
import {
  listenForNotices,
  noticeEnvelope,
  type MessageSenderLike,
  type RuntimeListener,
} from '@/src/shared/messaging.ts';
import {
  isMaskItem,
  isVaultNotice,
  MAX_MASK_ITEMS,
  MAX_VALUE_LENGTH,
  VAULT_PROTOCOL,
  type MaskItem,
  type VaultNotice,
} from '@/src/shared/vault-protocol.ts';
import { EXTENSION_ID } from '../extension-fakes.ts';

const UUID = '6f1c2a4e-8b3d-4c5e-9f7a-1b2c3d4e5f60';
const CONV_ID = '6800a1b2-c3d4-4e5f-8a9b-0c1d2e3f4a5b';

// Fixture identity address (example.com is reserved for documentation).
const ITEM: MaskItem = {
  type: 'EMAIL',
  subtype: null,
  country: null,
  value: 'dana.whitfield@example.com',
  normalised: 'dana.whitfield@example.com',
};

describe('conversation IDs', () => {
  it('builds and parses named and pending IDs', () => {
    expect(activeConversationId('chatgpt', CONV_ID)).toBe(`chatgpt:${CONV_ID}`);
    expect(pendingConversationId('chatgpt', UUID)).toBe(
      `chatgpt:pending:${UUID}`,
    );
    expect(parseConversationId(`chatgpt:${CONV_ID}`)).toEqual({
      site: 'chatgpt',
      kind: 'active',
      siteConversationId: CONV_ID,
    });
    expect(parseConversationId(`chatgpt:pending:${UUID}`)).toEqual({
      site: 'chatgpt',
      kind: 'pending',
      uuid: UUID,
    });
  });

  it('refuses anything else', () => {
    for (const value of [
      42,
      null,
      CONV_ID,
      `gemini:${CONV_ID}`,
      `other:${CONV_ID}`,
      'chatgpt:short',
      `chatgpt:${'a'.repeat(129)}`,
      'chatgpt:with/slash',
      'chatgpt:pending:',
      `chatgpt:pending:${UUID.toUpperCase()}`,
      'chatgpt:pending:6f1c2a4e-8b3d-1c5e-9f7a-1b2c3d4e5f60',
      `chatgpt:pending:${UUID}:x`,
      'chatgpt:pending',
    ]) {
      expect(parseConversationId(value)).toBeNull();
    }
    expect(isSiteConversationId('chatgpt', CONV_ID)).toBe(true);
    expect(isSiteConversationId('chatgpt', 'pending:x')).toBe(false);
    expect(isSiteConversationId('gemini', CONV_ID)).toBe(false);
  });
});

describe('vault message shapes', () => {
  const mask = VAULT_PROTOCOL['vault.mask'];
  const load = VAULT_PROTOCOL['vault.load'];
  const migrate = VAULT_PROTOCOL['vault.migrate'];

  it('checks mask items field by field', () => {
    expect(isMaskItem(ITEM)).toBe(true);
    expect(
      isMaskItem({
        type: 'NATIONAL_ID',
        subtype: 'UK_NINO',
        country: 'GB',
        value: 'QQ 12 34 56 C',
        normalised: 'QQ123456C',
      }),
    ).toBe(true);
    for (const item of [
      { ...ITEM, type: 'NAME' },
      { ...ITEM, subtype: 'XX_ID' },
      { ...ITEM, country: 'ZZ' },
      { ...ITEM, value: '' },
      { ...ITEM, value: 'x'.repeat(MAX_VALUE_LENGTH + 1) },
      { ...ITEM, normalised: 7 },
      null,
    ]) {
      expect(isMaskItem(item)).toBe(false);
    }
  });

  it('limits a mask request to 1–200 items', () => {
    const request = (count: number) => ({
      conversationId: 'chatgpt:abcdefgh',
      items: Array.from({ length: count }, () => ITEM),
    });
    expect(mask.request(request(1))).toBe(true);
    expect(mask.request(request(MAX_MASK_ITEMS))).toBe(true);
    expect(mask.request(request(MAX_MASK_ITEMS + 1))).toBe(false);
    expect(mask.request(request(0))).toBe(false);
    expect(mask.request({ conversationId: '', items: [ITEM] })).toBe(false);
  });

  it('checks replies, including failure codes', () => {
    expect(
      mask.response({ status: 'ok', standIns: ['standin.1@example.net'] }),
    ).toBe(true);
    expect(mask.response({ status: 'ok', standIns: [''] })).toBe(false);
    expect(mask.response({ status: 'keys-lost' })).toBe(true);
    expect(mask.response({ status: 'error', code: 'forbidden' })).toBe(true);
    expect(mask.response({ status: 'error', code: 'constraint' })).toBe(true);
    expect(mask.response({ status: 'error', code: 'oops' })).toBe(false);
    expect(mask.response({ status: 'error', code: 'toString' })).toBe(false);
    expect(
      load.response({
        status: 'ok',
        mappings: [{ standIn: 's', real: 'r', type: 'EMAIL' }],
        failed: 0,
      }),
    ).toBe(true);
    expect(load.response({ status: 'ok', mappings: [], failed: -1 })).toBe(
      false,
    );
    expect(load.request({ conversationId: 'chatgpt:abcdefgh' })).toBe(true);
    expect(migrate.request({ from: 'a', to: 'b' })).toBe(true);
    expect(migrate.request({ from: 'a' })).toBe(false);
    expect(migrate.response({ status: 'migrated', count: 2 })).toBe(true);
    expect(migrate.response({ status: 'nothing' })).toBe(true);
    expect(migrate.response({ status: 'migrated' })).toBe(false);
  });

  it('checks notices', () => {
    expect(
      isVaultNotice({
        name: 'vault.changed',
        conversationId: 'chatgpt:abcdefgh',
      }),
    ).toBe(true);
    expect(
      isVaultNotice({ name: 'vault.dropped', conversationIds: 'all' }),
    ).toBe(true);
    expect(
      isVaultNotice({
        name: 'vault.dropped',
        conversationIds: ['chatgpt:a1b2c3d4'],
      }),
    ).toBe(true);
    expect(
      isVaultNotice({ name: 'vault.dropped', conversationIds: 'some' }),
    ).toBe(false);
    expect(isVaultNotice({ name: 'vault.changed' })).toBe(false);
  });
});

describe('notice listener', () => {
  function receiver() {
    const listeners = new Set<RuntimeListener>();
    const runtime = {
      id: EXTENSION_ID as string | undefined,
      sendMessage: () => Promise.resolve(undefined),
      onMessage: {
        addListener: (listener: RuntimeListener) => {
          listeners.add(listener);
        },
        removeListener: (listener: RuntimeListener) => {
          listeners.delete(listener);
        },
      },
    };
    const received: VaultNotice[] = [];
    const stop = listenForNotices(runtime, isVaultNotice, (notice) => {
      received.push(notice);
    });
    const deliver = (message: unknown, sender: MessageSenderLike) => {
      for (const listener of listeners) {
        expect(listener(message, sender, () => undefined)).toBeUndefined();
      }
    };
    return { runtime, received, stop, deliver, listeners };
  }

  const notice: VaultNotice = { name: 'vault.dropped', conversationIds: 'all' };

  it('accepts notices from the extension itself only', () => {
    const { received, deliver } = receiver();
    deliver(noticeEnvelope(notice), { id: EXTENSION_ID });
    // Relayed by a content script (it has a tab), or from another extension.
    deliver(noticeEnvelope(notice), { id: EXTENSION_ID, tab: { id: 4 } });
    deliver(noticeEnvelope(notice), { id: 'another-extension' });
    // Malformed, or not a notice at all.
    deliver(noticeEnvelope({ name: 'vault.dropped' }), { id: EXTENSION_ID });
    deliver(
      { channel: 'promptveil/1', name: 'x', request: {} },
      { id: EXTENSION_ID },
    );
    deliver('hello', { id: EXTENSION_ID });
    expect(received).toEqual([notice]);
  });

  it('ignores notices once the extension context is gone, and can stop', () => {
    const { runtime, received, deliver, stop, listeners } = receiver();
    runtime.id = undefined;
    deliver(noticeEnvelope(notice), { id: EXTENSION_ID });
    expect(received).toEqual([]);
    stop();
    expect(listeners.size).toBe(0);
  });
});
