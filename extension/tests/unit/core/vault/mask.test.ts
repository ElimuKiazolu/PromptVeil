import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import { normaliseReal } from '@/src/core/detect/normal-form.ts';
import { isSpikeStandIn } from '@/src/core/spike-standin.ts';
import {
  commitMask,
  peekMask,
  prepareMask,
  type PrepareRequest,
} from '@/src/core/vault/mask.ts';
import {
  loadConversation,
  type VaultContext,
} from '@/src/core/vault/mappings.ts';
import { STORE } from '@/src/core/vault/schema.ts';
import {
  dumpAll,
  getRaw,
  maskValues,
  numbered,
  readyContext,
  realValue,
} from './harness.ts';

const PENDING = 'chatgpt:pending:6f1c2a4e-8b3d-4c5e-9f7a-1b2c3d4e5f60';
const ACTIVE = 'chatgpt:conv-1';

// Fixture identity addresses (example.com is reserved for documentation).
const DANA = realValue({
  type: 'EMAIL',
  subtype: null,
  country: null,
  value: 'Dana.Whitfield@example.com',
});
const ROBIN = realValue({
  type: 'EMAIL',
  subtype: null,
  country: null,
  value: 'robin.hale@example.org',
});

function request(
  items: PrepareRequest['items'],
  conversationId = ACTIVE,
): PrepareRequest {
  return {
    conversationId,
    site: 'chatgpt',
    status: conversationId === PENDING ? 'pending' : 'active',
    items,
  };
}

const entry = (real: typeof DANA, standIn: string) => ({
  real,
  standIn,
  standInNormalised: normaliseReal(
    real.type,
    real.subtype,
    real.country,
    standIn,
  ),
});

/** The context with its database counting transactions by mode. */
function counting(context: VaultContext) {
  const opened: IDBTransactionMode[] = [];
  const db = context.db;
  const counted = new Proxy(db, {
    get(target, property) {
      if (property === 'transaction') {
        return (
          stores: string | string[],
          mode?: IDBTransactionMode,
        ): IDBTransaction => {
          opened.push(mode ?? 'readonly');
          return target.transaction(stores, mode);
        };
      }
      const value: unknown = Reflect.get(target, property);
      return typeof value === 'function'
        ? (...args: unknown[]): unknown =>
            Reflect.apply(value, target, args) as unknown
        : value;
    },
  });
  return { context: { ...context, db: counted }, opened };
}

describe('prepareMask', () => {
  it('creates the conversation and gives each new value a seed and a number', async () => {
    const context = await readyContext();
    const prepared = await prepareMask(
      context,
      request([DANA, ROBIN], PENDING),
    );
    const conversation = await getRaw(context.db, STORE.conversations, PENDING);
    expect(conversation).toMatchObject({
      site: 'chatgpt',
      status: 'pending',
      mappingCount: 0,
    });
    expect(prepared.dateOffsetDays).toBe(
      (conversation as { dateOffsetDays: number }).dateOffsetDays,
    );
    const [dana, robin] = prepared.values;
    if (dana?.kind !== 'new' || robin?.kind !== 'new') throw new Error('new');
    expect(dana.seed).toHaveLength(32);
    expect(dana.number).toBe(1);
    expect(robin.number).toBe(2);
    expect(dana.seed).not.toEqual(robin.seed);
  });

  it('derives the seed from the conversation and the normal form (TR-S1)', async () => {
    const context = await readyContext();
    const seedOf = async (real: typeof DANA, conversationId: string) => {
      const [value] = (
        await prepareMask(context, request([real], conversationId))
      ).values;
      if (value?.kind !== 'new') throw new Error('new');
      return value.seed;
    };
    const first = await seedOf(DANA, ACTIVE);
    expect(
      await seedOf(
        realValue({ ...DANA, value: 'dana.whitfield@EXAMPLE.com' }),
        ACTIVE,
      ),
    ).toEqual(first);
    expect(await seedOf(DANA, 'chatgpt:conv-2')).not.toEqual(first);
  });

  it('returns stored stand-ins, numbering new values after them', async () => {
    const context = await readyContext();
    const { standIns } = await maskValues(context, request([DANA]));
    const prepared = await prepareMask(context, request([ROBIN, DANA]));
    expect(prepared.values[1]).toEqual({
      kind: 'existing',
      standIn: standIns[0],
    });
    expect(prepared.values[0]).toMatchObject({ kind: 'new', number: 2 });
  });

  it('uses one transaction whatever the number of values', async () => {
    const base = await readyContext();
    const { context, opened } = counting(base);
    const items = Array.from({ length: 50 }, (_, i) =>
      realValue({
        type: 'EMAIL',
        subtype: null,
        country: null,
        value: `person.${i.toString()}@example.com`,
      }),
    );
    await prepareMask(context, request(items));
    expect(opened).toEqual(['readwrite']);
  });
});

describe('peekMask', () => {
  it('looks values up without writing anything', async () => {
    const context = await readyContext();
    const before = await dumpAll(context.db);
    const peeked = await peekMask(context, PENDING, [DANA]);
    expect(peeked.dateOffsetDays).toBeNull();
    expect(peeked.values[0]).toMatchObject({ kind: 'new', number: 1 });
    expect(await dumpAll(context.db)).toEqual(before);
  });

  it('gives the same seeds and stand-ins as prepareMask, in one read-only transaction', async () => {
    const base = await readyContext();
    const { standIns } = await maskValues(base, request([DANA]));
    const { context, opened } = counting(base);
    const peeked = await peekMask(context, ACTIVE, [DANA, ROBIN]);
    expect(opened).toEqual(['readonly']);
    const prepared = await prepareMask(base, request([DANA, ROBIN]));
    expect(peeked).toEqual(prepared);
    expect(peeked.values[0]).toEqual({
      kind: 'existing',
      standIn: standIns[0],
    });
  });
});

describe('commitMask', () => {
  it('stores stand-ins and counts them on the conversation', async () => {
    const context = await readyContext();
    await prepareMask(context, request([DANA, ROBIN]));
    const result = await commitMask(context, ACTIVE, [
      entry(DANA, 'standin.1.aaaa@example.net'),
      entry(ROBIN, 'standin.2.bbbb@example.net'),
    ]);
    expect(result).toEqual({
      inserted: 2,
      missing: 0,
      values: [
        { kind: 'inserted', standIn: 'standin.1.aaaa@example.net' },
        { kind: 'inserted', standIn: 'standin.2.bbbb@example.net' },
      ],
    });
    expect(await getRaw(context.db, STORE.conversations, ACTIVE)).toMatchObject(
      { mappingCount: 2 },
    );
  });

  it('uses one transaction for any number of entries and reused values', async () => {
    const base = await readyContext();
    await maskValues(base, request([DANA]));
    await prepareMask(base, request([ROBIN]));
    const { context, opened } = counting(base);
    const entries = Array.from({ length: 40 }, (_, i) =>
      entry(
        realValue({
          type: 'EMAIL',
          subtype: null,
          country: null,
          value: `person.${i.toString()}@example.com`,
        }),
        `standin.${(i + 10).toString()}@example.net`,
      ),
    );
    const result = await commitMask(context, ACTIVE, entries, [DANA]);
    expect(result.inserted).toBe(40);
    expect(opened).toEqual(['readwrite']);
  });

  it('reports a stand-in used for another value as taken', async () => {
    const context = await readyContext();
    await prepareMask(context, request([DANA, ROBIN]));
    await commitMask(context, ACTIVE, [entry(DANA, 'standin.1@example.net')]);
    expect(
      await commitMask(context, ACTIVE, [
        entry(ROBIN, 'STANDIN.1@example.net'),
      ]),
    ).toEqual({ inserted: 0, missing: 0, values: [{ kind: 'taken' }] });
  });

  it('reports a stand-in equal to a stored real value as taken (TR-S3)', async () => {
    const context = await readyContext();
    await prepareMask(context, request([DANA, ROBIN]));
    await commitMask(context, ACTIVE, [entry(DANA, 'standin.1@example.net')]);
    expect(
      await commitMask(context, ACTIVE, [
        entry(ROBIN, 'dana.whitfield@example.COM'),
      ]),
    ).toEqual({ inserted: 0, missing: 0, values: [{ kind: 'taken' }] });
    expect((await dumpAll(context.db)).get(STORE.mappings)).toHaveLength(1);
  });

  it('applies the checks to entries of the same request too', async () => {
    const context = await readyContext();
    await prepareMask(context, request([DANA, ROBIN]));
    const result = await commitMask(context, ACTIVE, [
      entry(DANA, 'standin.1@example.net'),
      // The same value again, then another value with the same stand-in.
      entry(DANA, 'standin.2@example.net'),
      entry(ROBIN, 'standin.1@example.net'),
    ]);
    expect(result.values).toEqual([
      { kind: 'inserted', standIn: 'standin.1@example.net' },
      { kind: 'existing', standIn: 'standin.1@example.net' },
      { kind: 'taken' },
    ]);
    expect(result.inserted).toBe(1);
  });

  it('returns the stored stand-in when another tab stored the value first', async () => {
    const context = await readyContext();
    await prepareMask(context, request([DANA]));
    await commitMask(context, ACTIVE, [entry(DANA, 'standin.1@example.net')]);
    expect(
      await commitMask(context, ACTIVE, [entry(DANA, 'standin.9@example.net')]),
    ).toEqual({
      inserted: 0,
      missing: 0,
      values: [{ kind: 'existing', standIn: 'standin.1@example.net' }],
    });
  });

  it('ends with one mapping when two tabs commit the same value at once', async () => {
    const factory = new IDBFactory();
    const a = await readyContext(factory);
    await prepareMask(a, request([DANA]));
    const results = await Promise.all([
      commitMask(a, ACTIVE, [entry(DANA, 'standin.1@example.net')]),
      commitMask(a, ACTIVE, [entry(DANA, 'standin.2@example.net')]),
    ]);
    const kinds = results.map((result) => result.values[0]?.kind).sort();
    expect(kinds).toEqual(['existing', 'inserted']);
    expect((await dumpAll(a.db)).get(STORE.mappings)).toHaveLength(1);
  });

  it('counts the reuse of stored values and marks the conversation as used', async () => {
    let clock = 1_000;
    const context = await readyContext(new IDBFactory(), () => clock);
    await maskValues(context, request([DANA]));
    clock = 5_000;
    expect(await commitMask(context, ACTIVE, [], [DANA])).toEqual({
      values: [],
      inserted: 0,
      missing: 0,
    });
    const [record] = (await dumpAll(context.db)).get(STORE.mappings) ?? [];
    expect(record).toMatchObject({ hitCount: 1 });
    expect(await getRaw(context.db, STORE.conversations, ACTIVE)).toMatchObject(
      { lastUsedAt: 5_000, mappingCount: 1 },
    );
  });

  it('reports reused values that are no longer stored', async () => {
    const context = await readyContext();
    await prepareMask(context, request([DANA]));
    expect(await commitMask(context, ACTIVE, [], [ROBIN])).toMatchObject({
      missing: 1,
    });
  });

  it('fails without the conversation (prepareMask creates it)', async () => {
    const context = await readyContext();
    await expect(
      commitMask(context, ACTIVE, [entry(DANA, 'standin.1@example.net')]),
    ).rejects.toThrow('no-conversation');
  });
});

describe('masking through both steps', () => {
  it('issues engine stand-ins: spike format numbered from the stored count', async () => {
    const context = await readyContext();
    const result = await maskValues(context, request([DANA, ROBIN], PENDING));
    expect(result.inserted).toBe(2);
    for (const standIn of result.standIns) {
      expect(isSpikeStandIn(standIn)).toBe(true);
    }
    expect(result.standIns[0]).toMatch(
      /^standin\.1\.[a-z0-9]{4}@example\.net$/,
    );
    expect(result.standIns[1]).toMatch(
      /^standin\.2\.[a-z0-9]{4}@example\.net$/,
    );
  });

  it('stores a value repeated within one request once', async () => {
    const context = await readyContext();
    const result = await maskValues(context, request([DANA, DANA]));
    expect(result.standIns[0]).toBe(result.standIns[1]);
    expect(result.inserted).toBe(1);
    expect((await dumpAll(context.db)).get(STORE.mappings)).toHaveLength(1);
  });

  it('keeps conversations apart', async () => {
    const context = await readyContext();
    const [inA] = (await maskValues(context, request([DANA]))).standIns;
    const [inB] = (await maskValues(context, request([DANA], 'chatgpt:conv-2')))
      .standIns;
    expect(inA).not.toBe(inB);
  });

  it('moves to the next attempt when a stand-in is taken', async () => {
    const context = await readyContext();
    const fixed = numbered((n) => `standin.${n.toString()}@example.net`);
    await maskValues(context, request([DANA]), fixed);
    const result = await maskValues(
      context,
      request([ROBIN]),
      numbered((n) => `standin.${(n - 1).toString()}@example.net`),
    );
    expect(result.standIns).toEqual(['standin.2@example.net']);
    const loaded = await loadConversation(context, ACTIVE);
    expect(loaded.entries.map((e) => e.surrogate).sort()).toEqual([
      'standin.1@example.net',
      'standin.2@example.net',
    ]);
  });
});
