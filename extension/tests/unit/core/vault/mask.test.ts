import { describe, expect, it } from 'vitest';
import { normaliseReal } from '@/src/core/detect/normal-form.ts';
import { isSpikeStandIn } from '@/src/core/spike-standin.ts';
import {
  commitMask,
  prepareMask,
  type PrepareRequest,
} from '@/src/core/vault/mask.ts';
import { loadConversation } from '@/src/core/vault/mappings.ts';
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
    // Another written form of the same address has the same normal form.
    expect(
      await seedOf(
        realValue({ ...DANA, value: 'dana.whitfield@EXAMPLE.com' }),
        ACTIVE,
      ),
    ).toEqual(first);
    expect(await seedOf(DANA, 'chatgpt:conv-2')).not.toEqual(first);
  });

  it('returns stored stand-ins and counts the reuse', async () => {
    const context = await readyContext();
    const { standIns } = await maskValues(context, request([DANA]));
    const prepared = await prepareMask(context, request([ROBIN, DANA]));
    expect(prepared.values[1]).toEqual({
      kind: 'existing',
      standIn: standIns[0],
    });
    // Numbering continues after the stored mappings.
    expect(prepared.values[0]).toMatchObject({ kind: 'new', number: 2 });
    const [record] = (await dumpAll(context.db)).get(STORE.mappings) ?? [];
    expect(record).toMatchObject({ hitCount: 1 });
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
      values: [
        { kind: 'inserted', standIn: 'standin.1.aaaa@example.net' },
        { kind: 'inserted', standIn: 'standin.2.bbbb@example.net' },
      ],
    });
    expect(await getRaw(context.db, STORE.conversations, ACTIVE)).toMatchObject(
      { mappingCount: 2 },
    );
  });

  it('reports a stand-in used for another value as taken', async () => {
    const context = await readyContext();
    await prepareMask(context, request([DANA, ROBIN]));
    await commitMask(context, ACTIVE, [entry(DANA, 'standin.1@example.net')]);
    // Another separator or case form of the same stand-in is the same one.
    expect(
      await commitMask(context, ACTIVE, [
        entry(ROBIN, 'STANDIN.1@example.net'),
      ]),
    ).toEqual({ inserted: 0, values: [{ kind: 'taken' }] });
  });

  it('reports a stand-in equal to a stored real value as taken (TR-S3)', async () => {
    const context = await readyContext();
    await prepareMask(context, request([DANA, ROBIN]));
    await commitMask(context, ACTIVE, [entry(DANA, 'standin.1@example.net')]);
    // Robin's stand-in would be Dana's real address (in another case).
    expect(
      await commitMask(context, ACTIVE, [
        entry(ROBIN, 'dana.whitfield@example.COM'),
      ]),
    ).toEqual({ inserted: 0, values: [{ kind: 'taken' }] });
    expect((await dumpAll(context.db)).get(STORE.mappings)).toHaveLength(1);
  });

  it('returns the stored stand-in when another tab stored the value first', async () => {
    const context = await readyContext();
    await prepareMask(context, request([DANA]));
    await commitMask(context, ACTIVE, [entry(DANA, 'standin.1@example.net')]);
    expect(
      await commitMask(context, ACTIVE, [entry(DANA, 'standin.9@example.net')]),
    ).toEqual({
      inserted: 0,
      values: [{ kind: 'existing', standIn: 'standin.1@example.net' }],
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
    // Robin's first choice is Dana's stand-in, as if issued meanwhile.
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
