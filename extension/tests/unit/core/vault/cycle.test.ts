import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import { DB_NAME, STORE } from '@/src/core/vault/schema.ts';
import { createVaultService } from '@/src/core/vault/service.ts';
import {
  dumpAll,
  findPlaintext,
  needles,
  openRaw,
  realValue,
  webCrypto,
} from './harness.ts';

const PENDING = 'chatgpt:pending:6f1c2a4e-8b3d-4c5e-9f7a-1b2c3d4e5f60';
const TARGET = 'chatgpt:6800a1b2-c3d4-4e5f-8a9b-0c1d2e3f4a5b';
const DAY = 86_400_000;

// Test values: fixture identity (fictional name, example.com address),
// libphonenumber's GB example number, the published example IBAN, UIDAI's
// test Aadhaar number, and a made-up random key.
const VALUES = [
  realValue({
    type: 'EMAIL',
    subtype: null,
    country: null,
    value: 'Dana.Whitfield@example.com',
  }),
  realValue({
    type: 'PHONE',
    subtype: null,
    country: 'GB',
    value: '07400 123456',
  }),
  realValue({
    type: 'BANK',
    subtype: 'IBAN',
    country: 'GB',
    value: 'GB82 WEST 1234 5698 7654 32',
  }),
  realValue({
    type: 'NATIONAL_ID',
    subtype: 'IN_AADHAAR',
    country: 'IN',
    value: '9999 4105 7058',
  }),
  realValue({
    type: 'PERSON',
    subtype: null,
    country: null,
    value: 'Dana Whitfield',
  }),
  realValue({
    type: 'SECRET',
    subtype: null,
    country: null,
    value: 'Zq8fK2mVx9LpR4tW7nB3cY6hJ1dG5sQe',
  }),
];

async function expectNoPlaintext(factory: IDBFactory): Promise<void> {
  const db = await openRaw(factory, DB_NAME);
  const forms = VALUES.flatMap(needles);
  for (const [store, records] of await dumpAll(db)) {
    expect(findPlaintext(records, forms, store)).toEqual([]);
  }
  db.close();
}

describe('plaintext scan over a whole cycle', () => {
  it('finds no real value or normal form after mask, migrate, auto-delete and delete-all', async () => {
    const factory = new IDBFactory();
    const clock = { now: 1_000 * DAY };
    const vault = createVaultService({
      idb: factory,
      crypto: webCrypto,
      now: () => clock.now,
    });

    const masked = await vault.maskValues({
      conversationId: PENDING,
      site: 'chatgpt',
      status: 'pending',
      items: VALUES,
    });
    // A repeat send reuses every stand-in.
    expect(
      (
        await vault.maskValues({
          conversationId: PENDING,
          site: 'chatgpt',
          status: 'pending',
          items: VALUES,
        })
      ).standIns,
    ).toEqual(masked.standIns);
    await expectNoPlaintext(factory);

    expect(await vault.migrate(PENDING, TARGET)).toMatchObject({
      status: 'migrated',
      count: VALUES.length,
    });
    expect((await vault.loadConversation(TARGET)).entries).toHaveLength(
      VALUES.length,
    );
    await expectNoPlaintext(factory);

    clock.now += 31 * DAY;
    expect(await vault.deleteExpired({ retentionDays: 30 })).toMatchObject({
      conversations: [TARGET],
      mappings: VALUES.length,
    });
    await expectNoPlaintext(factory);

    await vault.maskValues({
      conversationId: TARGET,
      site: 'chatgpt',
      status: 'active',
      items: VALUES,
    });
    await vault.deleteDatabase();
    expect((await vault.ensureKeys()).status).toBe('ready');
    const db = await openRaw(factory, DB_NAME);
    const dump = await dumpAll(db);
    db.close();
    expect(dump.get(STORE.mappings)).toEqual([]);
    expect(dump.get(STORE.conversations)).toEqual([]);
    expect(dump.get(STORE.keys)).toHaveLength(3);
    await expectNoPlaintext(factory);
    vault.close();
  });
});
