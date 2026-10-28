import { Buffer } from 'node:buffer';
import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import type { Mapping } from '@/src/shared/entities.ts';
import { VaultError } from '@/src/core/vault/errors.ts';
import { ensureKeys } from '@/src/core/vault/keys.ts';
import {
  createConversation,
  findByReal,
  insertMapping,
  isStandInTaken,
  loadConversation,
  type NewMapping,
  type RealValue,
  type VaultContext,
} from '@/src/core/vault/mappings.ts';
import { normaliseReal } from '@/src/core/vault/normalise.ts';
import { STORE } from '@/src/core/vault/schema.ts';
import { dumpAll, getRaw, openV1, putRaw, webCrypto } from './harness.ts';

const CONV = 'chatgpt:conv-1';
const OTHER_CONV = 'chatgpt:conv-2';

async function setUp(factory = new IDBFactory()): Promise<VaultContext> {
  const db = await openV1(factory);
  const state = await ensureKeys(db, webCrypto, () => 1);
  if (state.status !== 'ready') throw new Error('keys not ready');
  let clock = 100;
  const context: VaultContext = {
    db,
    crypto: webCrypto,
    keys: state.keys,
    now: () => (clock += 1),
  };
  await createConversation(context, {
    id: CONV,
    site: 'chatgpt',
    status: 'active',
  });
  await createConversation(context, {
    id: OTHER_CONV,
    site: 'chatgpt',
    status: 'active',
  });
  return context;
}

// Test values: fixture identity (fictional name, example.com address),
// libphonenumber's GB example number, the published example IBAN, UIDAI's
// test Aadhaar number, and a made-up random key.
const EMAIL: RealValue = {
  type: 'EMAIL',
  subtype: null,
  country: null,
  value: 'Dana.Whitfield@example.com',
};
const PHONE: RealValue = {
  type: 'PHONE',
  subtype: null,
  country: 'GB',
  value: '07400 123456',
};
const IBAN: RealValue = {
  type: 'BANK',
  subtype: 'IBAN',
  country: 'GB',
  value: 'GB82 WEST 1234 5698 7654 32',
};
const AADHAAR: RealValue = {
  type: 'NATIONAL_ID',
  subtype: 'IN_AADHAAR',
  country: 'IN',
  value: '9999 4105 7058',
};
const PERSON: RealValue = {
  type: 'PERSON',
  subtype: null,
  country: null,
  value: 'Dana Whitfield',
};
const SECRET: RealValue = {
  type: 'SECRET',
  subtype: null,
  country: null,
  value: 'Zq8fK2mVx9LpR4tW7nB3cY6hJ1dG5sQe',
};

function newMapping(
  real: RealValue,
  surrogate: string,
  conversationId = CONV,
): NewMapping {
  return {
    conversationId,
    real,
    surrogate,
    variants: [],
    locale: null,
    parentId: null,
    source: 'rule',
    confidence: 0.99,
  };
}

async function inserted(
  context: VaultContext,
  input: NewMapping,
): Promise<Mapping> {
  const result = await insertMapping(context, input);
  if (result.status !== 'inserted')
    throw new Error(`not inserted: ${result.status}`);
  return result.mapping;
}

async function conversationRecord(context: VaultContext, id = CONV) {
  return getRaw(context.db, STORE.conversations, id);
}

function codeOf(error: unknown): string {
  return error instanceof VaultError ? error.code : 'not a VaultError';
}

describe('conversations', () => {
  it('creates a conversation once with a date offset in range', async () => {
    const context = await setUp();
    const record = await createConversation(context, {
      id: 'claude:pending:x',
      site: 'claude',
      status: 'pending',
    });
    expect(Math.abs(record.dateOffsetDays)).toBeGreaterThanOrEqual(30);
    expect(Math.abs(record.dateOffsetDays)).toBeLessThanOrEqual(365);
    expect(record.mappingCount).toBe(0);
    const again = await createConversation(context, {
      id: 'claude:pending:x',
      site: 'claude',
      status: 'pending',
    });
    expect(again).toEqual(record);
  });

  it('rejects a malformed stored conversation', async () => {
    const context = await setUp();
    await putRaw(context.db, STORE.conversations, {
      id: 'chatgpt:bad',
      site: 'x',
    });
    await expect(
      createConversation(context, {
        id: 'chatgpt:bad',
        site: 'chatgpt',
        status: 'active',
      }),
    ).rejects.toSatisfy((error: unknown) => codeOf(error) === 'corrupt-record');
  });
});

describe('insert and find', () => {
  it('stores a mapping, finds it by any separator or case form, and counts reuses', async () => {
    const context = await setUp();
    const mapping = await inserted(
      context,
      newMapping(AADHAAR, '2345 6789 0123'),
    );
    expect(mapping.hitCount).toBe(0);
    expect(mapping.surrogateNorm).toBe('234567890123');
    expect(await conversationRecord(context)).toMatchObject({
      mappingCount: 1,
    });

    const first = await findByReal(context, CONV, {
      ...AADHAAR,
      value: '999941057058',
    });
    expect(first?.id).toBe(mapping.id);
    expect(first?.hitCount).toBe(1);
    const second = await findByReal(context, CONV, {
      ...AADHAAR,
      value: '9999-4105-7058',
    });
    expect(second?.hitCount).toBe(2);
    const stored = await getRaw(context.db, STORE.mappings, mapping.id);
    expect(stored).toMatchObject({ hitCount: 2 });
    expect(await conversationRecord(context)).toMatchObject({
      mappingCount: 1,
    });
  });

  it('keeps conversations, types and subtypes apart', async () => {
    const context = await setUp();
    await inserted(context, newMapping(AADHAAR, '2345 6789 0123'));
    expect(await findByReal(context, OTHER_CONV, AADHAAR)).toBeNull();
    expect(
      await findByReal(context, CONV, { ...AADHAAR, subtype: 'IN_VID' }),
    ).toBeNull();
    expect(
      await findByReal(context, CONV, { ...AADHAAR, type: 'PHONE' }),
    ).toBeNull();
  });

  it('reports stand-ins already used, in any case or separator form', async () => {
    const context = await setUp();
    await inserted(context, newMapping(EMAIL, 'standin.one@example.net'));
    expect(await isStandInTaken(context, CONV, 'StandIn.One@Example.NET')).toBe(
      true,
    );
    expect(
      await isStandInTaken(context, OTHER_CONV, 'standin.one@example.net'),
    ).toBe(false);
    expect(await isStandInTaken(context, CONV, 'standin.two@example.net')).toBe(
      false,
    );
  });

  it('returns the existing mapping when the same value is inserted again', async () => {
    const context = await setUp();
    const first = await inserted(
      context,
      newMapping(EMAIL, 'standin.one@example.net'),
    );
    const again = await insertMapping(
      context,
      newMapping(
        { ...EMAIL, value: 'dana.whitfield@EXAMPLE.com' },
        'standin.two@example.net',
      ),
    );
    expect(again).toMatchObject({
      status: 'existing',
      mapping: { id: first.id, hitCount: 1 },
    });
    expect((await dumpAll(context.db)).get(STORE.mappings)).toHaveLength(1);
    expect(await conversationRecord(context)).toMatchObject({
      mappingCount: 1,
    });
  });

  it('ends with one mapping when two inserts of one value race', async () => {
    const factory = new IDBFactory();
    const tabA = await setUp(factory);
    // A second connection, as another context would have.
    const db = await openV1(factory);
    const tabB: VaultContext = { ...tabA, db };
    const results = await Promise.all([
      insertMapping(tabA, newMapping(PHONE, '07400 654321')),
      insertMapping(
        tabB,
        newMapping({ ...PHONE, value: '+44 7400 123456' }, '07400 765432'),
      ),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual([
      'existing',
      'inserted',
    ]);
    const ids = results.map((result) =>
      'mapping' in result ? result.mapping.id : null,
    );
    expect(ids[0]).toBe(ids[1]);
    expect((await dumpAll(tabA.db)).get(STORE.mappings)).toHaveLength(1);
    expect(await conversationRecord(tabA)).toMatchObject({ mappingCount: 1 });
    db.close();
  });

  it('reports a stand-in already used for another value', async () => {
    const context = await setUp();
    await inserted(context, newMapping(EMAIL, 'standin.one@example.net'));
    const result = await insertMapping(
      context,
      newMapping(
        { ...EMAIL, value: 'other.person@example.com' },
        'Standin.One@example.net',
      ),
    );
    expect(result).toEqual({ status: 'surrogate-taken' });
    expect((await dumpAll(context.db)).get(STORE.mappings)).toHaveLength(1);
    expect(await conversationRecord(context)).toMatchObject({
      mappingCount: 1,
    });
  });

  it('refuses a mapping for a conversation that does not exist, writing nothing', async () => {
    const context = await setUp();
    await expect(
      insertMapping(
        context,
        newMapping(EMAIL, 'standin.one@example.net', 'chatgpt:missing'),
      ),
    ).rejects.toSatisfy(
      (error: unknown) => codeOf(error) === 'no-conversation',
    );
    expect((await dumpAll(context.db)).get(STORE.mappings)).toEqual([]);
  });

  it('rejects a malformed stored mapping on lookup', async () => {
    const context = await setUp();
    const mapping = await inserted(
      context,
      newMapping(EMAIL, 'standin.one@example.net'),
    );
    await putRaw(context.db, STORE.mappings, { ...mapping, hitCount: 'many' });
    await expect(findByReal(context, CONV, EMAIL)).rejects.toSatisfy(
      (error: unknown) => codeOf(error) === 'corrupt-record',
    );
  });
});

describe('loadConversation', () => {
  it('decrypts every mapping of the conversation into memory', async () => {
    const context = await setUp();
    const email = await inserted(context, {
      ...newMapping(EMAIL, 'standin.one@example.net'),
      variants: ['standin.one'],
    });
    await inserted(context, newMapping(PHONE, '07400 654321'));
    await inserted(context, newMapping(PERSON, 'Robin Hale', OTHER_CONV));
    const loaded = await loadConversation(context, CONV);
    expect(loaded.failed).toBe(0);
    expect(loaded.entries).toHaveLength(2);
    expect(
      loaded.entries.find((entry) => entry.mappingId === email.id),
    ).toEqual({
      mappingId: email.id,
      type: 'EMAIL',
      subtype: null,
      country: null,
      surrogate: 'standin.one@example.net',
      variants: ['standin.one'],
      parentId: null,
      real: EMAIL.value,
    });
  });

  it('never shows a ciphertext copied into another record, a tampered one, or a malformed record', async () => {
    const context = await setUp();
    const a = await inserted(
      context,
      newMapping(EMAIL, 'standin.one@example.net'),
    );
    const b = await inserted(context, newMapping(PHONE, '07400 654321'));
    const c = await inserted(
      context,
      newMapping(IBAN, 'GB33 BUKB 2020 1555 5555 55'),
    );
    const d = await inserted(context, newMapping(AADHAAR, '2345 6789 0123'));

    // b carries a's ciphertext: authentication binds it to record a.
    await putRaw(context.db, STORE.mappings, { ...b, realEnc: a.realEnc });
    // c's ciphertext with one bit flipped.
    const ct = new Uint8Array(c.realEnc.ct.slice(0));
    ct[3] = (ct[3] ?? 0) ^ 0x10;
    await putRaw(context.db, STORE.mappings, {
      ...c,
      realEnc: { iv: c.realEnc.iv, ct: ct.buffer },
    });
    // d is no longer a valid record.
    await putRaw(context.db, STORE.mappings, { ...d, realEnc: 'plain' });

    const loaded = await loadConversation(context, CONV);
    expect(loaded.failed).toBe(3);
    expect(loaded.entries.map((entry) => entry.real)).toEqual([EMAIL.value]);
  });

  it('does not decrypt a mapping moved into another conversation', async () => {
    const context = await setUp();
    const mapping = await inserted(
      context,
      newMapping(EMAIL, 'standin.one@example.net'),
    );
    await putRaw(context.db, STORE.mappings, {
      ...mapping,
      conversationId: OTHER_CONV,
    });
    const loaded = await loadConversation(context, OTHER_CONV);
    expect(loaded).toEqual({ entries: [], failed: 1 });
  });
});

/** Byte and text forms a value could take if it were stored in the clear. */
function needles(real: RealValue): string[] {
  const forms = new Set<string>([
    real.value,
    real.value.toLowerCase(),
    real.value.toUpperCase(),
    normaliseReal(real.type, real.subtype, real.country, real.value),
  ]);
  const digits = real.value.replace(/\D/gu, '');
  if (digits.length >= 6) forms.add(digits);
  return [...forms];
}

/** Every place in a stored value where one of `forms` appears in plaintext. */
function findPlaintext(
  value: unknown,
  forms: readonly string[],
  path = '$',
): string[] {
  if (typeof value === 'string') {
    return forms.some((form) => value.includes(form)) ? [path] : [];
  }
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
    const bytes =
      value instanceof ArrayBuffer
        ? Buffer.from(value)
        : Buffer.from(value.buffer, value.byteOffset, value.byteLength);
    const hit = forms.some(
      (form) =>
        bytes.includes(Buffer.from(form, 'utf8')) ||
        bytes.includes(Buffer.from(form, 'utf16le')),
    );
    return hit ? [path] : [];
  }
  if (typeof value === 'object' && value !== null) {
    return Object.entries(value).flatMap(([key, child]) => [
      ...(forms.some((form) => key.includes(form)) ? [`${path} key`] : []),
      ...findPlaintext(child, forms, `${path}.${key}`),
    ]);
  }
  return [];
}

describe('plaintext scan', () => {
  it('stores no real value or normal form anywhere in any store', async () => {
    const context = await setUp();
    const values = [EMAIL, PHONE, IBAN, AADHAAR, PERSON, SECRET];
    const surrogates = [
      'standin.one@example.net',
      '07400 654321',
      'GB33 BUKB 2020 1555 5555 55',
      '2345 6789 0123',
      'Robin Hale',
      'Xw3pL8kQ2nV7rT5yB9mC4fH6jD1gS0aE',
    ];
    for (const [index, real] of values.entries()) {
      await inserted(context, newMapping(real, surrogates[index] ?? ''));
      // Reuse and a racing duplicate also write records.
      await findByReal(context, CONV, real);
      await insertMapping(
        context,
        newMapping(real, `other-${index.toString()}`),
      );
    }
    await loadConversation(context, CONV);

    const dump = await dumpAll(context.db);
    expect([...dump.keys()].sort()).toEqual(
      [
        'conversations',
        'customTerms',
        'keys',
        'log',
        'mappings',
        'meta',
      ].sort(),
    );
    expect(dump.get(STORE.mappings)).toHaveLength(values.length);
    const forms = values.flatMap(needles);
    // Sanity check: the scanner does find a value that is stored in the clear.
    expect(findPlaintext({ note: `x${EMAIL.value}x` }, forms)).toEqual([
      '$.note',
    ]);
    expect(findPlaintext(new TextEncoder().encode(PHONE.value), forms)).toEqual(
      ['$'],
    );

    for (const [store, records] of dump) {
      expect(findPlaintext(records, forms, store)).toEqual([]);
    }
  });
});
