import { sha256 } from '@noble/hashes/sha2.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import { base58 } from '@scure/base';
import { describe, expect, it } from 'vitest';
import { base58Checksum } from '@/src/core/detect/validators/crypto.ts';
import { normaliseReal } from '@/src/core/detect/normal-form.ts';
import { commitMask, prepareMask } from '@/src/core/vault/mask.ts';
import { loadConversation } from '@/src/core/vault/mappings.ts';
import { STORE } from '@/src/core/vault/schema.ts';
import type { RealValue } from '@/src/core/vault/mappings.ts';
import {
  dumpAll,
  findPlaintext,
  needles,
  readyContext,
  realValue,
} from './harness.ts';

const CONV = 'chatgpt:conv-1';

// Fixture identity name and address (example.org is reserved).
const HARRIET = realValue({
  type: 'PERSON',
  subtype: null,
  country: null,
  value: 'Dr. Harriet Pemberton',
});
const ADDRESS = realValue({
  type: 'EMAIL',
  subtype: null,
  country: null,
  value: 'harriet.pemberton@example.org',
});
const COMPANY = realValue({
  type: 'ORG',
  subtype: null,
  country: null,
  value: 'Pemberton & Clarke Ltd',
});
const HOME = realValue({
  type: 'ADDRESS',
  subtype: null,
  country: 'GB',
  value: '221B Baker Street, London NW1 6XE',
});

const entry = (
  real: RealValue,
  standIn: string,
  extra: { variants?: string[]; locale?: string; parent?: string } = {},
) => ({
  real,
  standIn,
  standInNormalised: normaliseReal(
    real.type,
    real.subtype,
    real.country,
    standIn,
  ),
  ...extra,
});

async function stored() {
  const context = await readyContext();
  await prepareMask(context, {
    conversationId: CONV,
    site: 'chatgpt',
    status: 'active',
    items: [HARRIET, ADDRESS, COMPANY, HOME],
  });
  await commitMask(context, CONV, [
    entry(HARRIET, 'Dr. Olivia Hughes', {
      variants: ['Olivia', 'Hughes'],
      locale: 'en_GB',
    }),
    entry(COMPANY, 'Hughes & Walsh Ltd', { locale: 'en_GB' }),
    entry(HOME, '47C Casper Street, London RG8 6NR', { locale: 'en_GB' }),
  ]);
  await commitMask(context, CONV, [
    entry(ADDRESS, 'olivia.hughes@example.net', {
      locale: 'en_GB',
      parent: 'Dr. Olivia Hughes',
    }),
  ]);
  return context;
}

describe('linked mappings in the vault', () => {
  it('store the locale, the stand-in parts and the link to the parent', async () => {
    const context = await stored();
    const loaded = await loadConversation(context, CONV);
    const person = loaded.entries.find((e) => e.type === 'PERSON');
    const email = loaded.entries.find((e) => e.type === 'EMAIL');
    expect(person).toMatchObject({
      variants: ['Olivia', 'Hughes'],
      locale: 'en_GB',
      parentId: null,
      real: HARRIET.value,
    });
    expect(email).toMatchObject({
      locale: 'en_GB',
      parentId: person?.mappingId,
      real: ADDRESS.value,
    });
  });

  it('leave no link when the parent is not stored', async () => {
    const context = await readyContext();
    await prepareMask(context, {
      conversationId: CONV,
      site: 'chatgpt',
      status: 'active',
      items: [ADDRESS],
    });
    await commitMask(context, CONV, [
      entry(ADDRESS, 'olivia.hughes@example.net', {
        parent: 'Dr. Olivia Hughes',
      }),
    ]);
    const [email] = (await loadConversation(context, CONV)).entries;
    expect(email?.parentId).toBeNull();
  });

  it('keep every real name, organisation and address out of the plaintext', async () => {
    const context = await stored();
    const dump = await dumpAll(context.db);
    const forms = [HARRIET, ADDRESS, COMPANY, HOME].flatMap(needles);
    // Real name parts too: only the stand-in's parts are stored.
    forms.push('Harriet', 'Pemberton', 'Baker');
    for (const store of [STORE.mappings, STORE.conversations, STORE.log]) {
      expect(findPlaintext(dump.get(store), forms)).toEqual([]);
    }
    // The stand-in side is stored as sent.
    expect(JSON.stringify(dump.get(STORE.mappings))).toContain('Olivia');
  });
});

describe('IP and crypto values in the vault', () => {
  it('stay out of the plaintext, in every writing', async () => {
    // A public IPv4 address and a Base58Check payload made in memory from a
    // fixed label (neither is written into the tests).
    const octets = Array.from(sha256(utf8ToBytes('vault ip')).slice(0, 4));
    const ip = `${String(41 + ((octets[0] ?? 0) % 100))}.${octets
      .slice(1)
      .join('.')}`;
    const payload = new Uint8Array(21);
    payload.set(sha256(utf8ToBytes('vault btc')).slice(0, 20), 1);
    const full = new Uint8Array(25);
    full.set(payload);
    full.set(base58Checksum(payload), 21);
    const address = base58.encode(full);
    const IP = realValue({
      type: 'IP',
      subtype: null,
      country: null,
      value: ip,
    });
    const BTC = realValue({
      type: 'CRYPTO',
      subtype: null,
      country: null,
      value: address,
    });
    const context = await readyContext();
    await prepareMask(context, {
      conversationId: CONV,
      site: 'chatgpt',
      status: 'active',
      items: [IP, BTC],
    });
    await commitMask(context, CONV, [
      entry(IP, '198.51.100.23'),
      entry(
        BTC,
        base58.encode(full.map((byte, i) => (i < 21 ? byte ^ 1 : byte))),
      ),
    ]);
    const dump = await dumpAll(context.db);
    const forms = [...needles(IP), ...needles(BTC), ip.replace(/\./gu, '')];
    for (const store of [STORE.mappings, STORE.conversations, STORE.log]) {
      expect(findPlaintext(dump.get(store), forms)).toEqual([]);
    }
    const loaded = await loadConversation(context, CONV);
    expect(loaded.entries.map((e) => e.real).sort()).toEqual(
      [ip, address].sort(),
    );
  });
});
