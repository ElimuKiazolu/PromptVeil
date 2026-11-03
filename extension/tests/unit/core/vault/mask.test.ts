import { describe, expect, it } from 'vitest';
import { isSpikeStandIn } from '@/src/core/spike-standin.ts';
import {
  MAX_STAND_IN_ATTEMPTS,
  maskValues,
  type MaskRequest,
} from '@/src/core/vault/mask.ts';
import { loadConversation } from '@/src/core/vault/mappings.ts';
import { STORE } from '@/src/core/vault/schema.ts';
import { codeOf, dumpAll, getRaw, readyContext, realValue } from './harness.ts';

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
  items: MaskRequest['items'],
  conversationId = ACTIVE,
): MaskRequest {
  return {
    conversationId,
    site: 'chatgpt',
    status: conversationId === PENDING ? 'pending' : 'active',
    items,
  };
}

describe('maskValues', () => {
  it('creates the conversation and issues tagged spike stand-ins', async () => {
    const context = await readyContext();
    const result = await maskValues(context, request([DANA, ROBIN], PENDING));
    expect(result.inserted).toBe(2);
    expect(result.standIns).toHaveLength(2);
    for (const standIn of result.standIns) {
      expect(isSpikeStandIn(standIn)).toBe(true);
    }
    expect(result.standIns[0]).toMatch(
      /^standin\.1\.[a-z0-9]{4}@example\.net$/,
    );
    expect(result.standIns[1]).toMatch(
      /^standin\.2\.[a-z0-9]{4}@example\.net$/,
    );
    expect(
      await getRaw(context.db, STORE.conversations, PENDING),
    ).toMatchObject({ site: 'chatgpt', status: 'pending', mappingCount: 2 });
  });

  it('gives a value the same stand-in in every later request', async () => {
    const context = await readyContext();
    const [first] = (await maskValues(context, request([DANA]))).standIns;
    const again = await maskValues(
      context,
      request([
        ROBIN,
        realValue({ ...DANA, value: 'dana.whitfield@EXAMPLE.com' }),
      ]),
    );
    expect(again.standIns[1]).toBe(first);
    expect(again.inserted).toBe(1);
    // Numbering continues from the stored count.
    expect(again.standIns[0]).toMatch(/^standin\.2\./);
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

  it('tries the next stand-in when one is already used', async () => {
    const context = await readyContext();
    const fixed = (number: number) =>
      `standin.${number.toString()}@example.net`;
    await maskValues(context, request([DANA]), fixed);
    // The first choice is taken, as when another tab issued it meanwhile.
    const result = await maskValues(context, request([ROBIN]), (number) =>
      fixed(number - 1),
    );
    expect(result.standIns).toEqual(['standin.2@example.net']);
    const loaded = await loadConversation(context, ACTIVE);
    expect(loaded.entries.map((entry) => entry.surrogate).sort()).toEqual([
      'standin.1@example.net',
      'standin.2@example.net',
    ]);
  });

  it(`gives up after ${MAX_STAND_IN_ATTEMPTS.toString()} stand-ins that are all taken`, async () => {
    const context = await readyContext();
    const always = () => 'standin.1@example.net';
    await maskValues(context, request([DANA]), always);
    let calls = 0;
    await expect(
      maskValues(context, request([ROBIN]), () => {
        calls += 1;
        return always();
      }),
    ).rejects.toSatisfy((error: unknown) => codeOf(error) === 'constraint');
    expect(calls).toBe(MAX_STAND_IN_ATTEMPTS);
    expect((await dumpAll(context.db)).get(STORE.mappings)).toHaveLength(1);
  });
});
