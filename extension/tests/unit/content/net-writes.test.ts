import { afterEach, describe, expect, it, vi } from 'vitest';
import { chatgptNetRules } from '@/src/adapters/chatgpt.ts';
import { startNetBridge } from '@/src/content/net-bridge.ts';
import { createDetection } from '@/src/core/detect/bundle.ts';
import type { Yielder } from '@/src/core/detect/schedule.ts';
import { checkUserTexts } from '@/src/core/net/write-check.ts';
import { needsMasking } from '@/src/core/pipeline.ts';
import { installNetGuard } from '@/src/net/guard.ts';
import type { EntityType } from '@/src/shared/entities.ts';
import {
  documentAtStart,
  fakeWindow,
  NINO,
  pageScriptsMayRun,
} from './net-fakes.ts';

const TYPES = new Set<EntityType>([
  'EMAIL',
  'PHONE',
  'CARD',
  'BANK',
  'SECRET',
  'NATIONAL_ID',
  'IP',
  'CRYPTO',
  'DOB',
]);

const immediate: Yielder = { now: () => 0, yieldNow: () => Promise.resolve() };

/** The email stand-in the card's recipient holds (issued in this chat). */
const RECIPIENT = 'olivia.hughes@example.net';

/**
 * The guard with the real detector behind the verify channel, after the
 * conversation's mappings were loaded: the net knows the recipient's
 * stand-in, the pipeline counts it as issued.
 */
function setUp(issued: readonly string[] = [RECIPIENT]) {
  const doc = documentAtStart();
  const env = fakeWindow();
  installNetGuard(env.win, doc, chatgptNetRules);
  const bridge = startNetBridge(doc);
  const runtime = createDetection(
    {
      homeRegions: ['GB'],
      preferredRegions: [],
      entityTypes: TYPES,
      idPacks: {},
      keepCity: true,
      maskPrivateIps: false,
    },
    immediate,
  );
  const asked: string[][] = [];
  bridge.setVerifier(async (texts) => {
    asked.push([...texts]);
    const result = await checkUserTexts(texts, {
      scan: (text) => runtime.scan(text),
      needsMasking: (found) =>
        needsMasking(found, TYPES, (value) => issued.includes(value)),
      isMaskedType: (found) => TYPES.has(found.type),
    });
    return { ...result, hashes: [] };
  });
  pageScriptsMayRun(doc);
  bridge.sync([
    { standIn: RECIPIENT, real: 'robin_hale@example.com', boundary: 'email' },
  ]);
  const Xhr = env.win.XMLHttpRequest as unknown as new () => XMLHttpRequest;
  const Ws = env.win.WebSocket as unknown as new () => WebSocket;
  return { ...env, bridge, asked, Xhr, Ws };
}

const CONVERSATION = '6acdb6c3-576c-83ee-9afa-959dd6bab8ce';
const WRITING_BLOCKS = `/backend-api/conversation/${CONVERSATION}/writing-blocks`;
const BS = '\\';

/** A writing-block save as ChatGPT sends it (markdown, escaped). */
const save = (content: string): string =>
  JSON.stringify({
    conversation_id: CONVERSATION,
    message_id: 'd887b261-5f9e-4157-af90-a32139bd89f7',
    updated_at: '2026-11-21T10:15:00.000Z',
    writing_block: {
      content,
      metadata: {
        subject: 'Housewarming',
        recipient: RECIPIENT,
        suggested_followups: [],
      },
      variant: 'email',
    },
  });

const outcome = (request: Promise<unknown>): Promise<string> =>
  request.then(
    () => 'sent',
    () => 'blocked',
  );

/** The text gzip-compressed, as an analytics client sends a batch. */
async function gzip(text: string): Promise<Uint8Array<ArrayBuffer>> {
  const input = new ReadableStream<BufferSource>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
  const output = input.pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(output).arrayBuffer());
}

function logLines(info: { mock: { calls: unknown[][] } }): string[] {
  return info.mock.calls.map((call) => String(call[0]));
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('writing-block saves', () => {
  it('blocks a card save with a new email, phone or national ID', async () => {
    const { win, sent } = setUp();
    // The live leak (a new address, escaped the way ChatGPT saves it), an
    // Ofcom-format number and HMRC's tutorial NINO with entity spaces.
    for (const content of [
      `Dear Sam,&#x20;write to sam${BS}_lee${BS}@example.com`,
      'Call me on 07400&#x20;123456 after six',
      'My NI number is AB&nbsp;12&nbsp;34&nbsp;56&nbsp;C',
    ]) {
      expect(
        await outcome(
          win.fetch(WRITING_BLOCKS, { method: 'POST', body: save(content) }),
        ),
        content,
      ).toBe('blocked');
    }
    expect(sent).toEqual([]);
  });

  it('lets a clean edit and issued stand-ins through', async () => {
    const { win, sent, asked } = setUp();
    await win.fetch(WRITING_BLOCKS, {
      method: 'POST',
      body: save(`Dear Olivia,&#x20;see you at six${BS}!`),
    });
    expect(sent).toEqual(['fetch']);
    // Content, subject and recipient, unescaped; no IDs or timestamps.
    expect(asked.flat()).toEqual([
      'Dear Olivia, see you at six!',
      'Housewarming',
      RECIPIENT,
    ]);
  });

  it('blocks a value masked earlier, entity-escaped, even over XHR', () => {
    const { bridge, sent, Xhr } = setUp();
    bridge.sync([
      {
        standIn: '07700 900123',
        real: '07400 123456',
        boundary: 'word',
        netForms: ['7400123456'],
      },
    ]);
    // XHR gets no full check: tier 2 alone must catch it.
    const xhr = new Xhr();
    xhr.open('POST', `https://chatgpt.com${WRITING_BLOCKS}`);
    xhr.send(save('Ring 07400&#x20;123456'));
    expect(sent).toEqual([]);
  });

  it('lets a "possible" value through and logs it as possible', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const { win, sent } = setUp();
    // libphonenumber's French mobile example, bare, with home GB.
    await win.fetch(WRITING_BLOCKS, {
      method: 'POST',
      body: save('see 0612345678 later'),
    });
    expect(sent).toEqual(['fetch']);
    const lines = logLines(info);
    expect(lines.some((line) => line.endsWith('result=possible'))).toBe(true);
    expect(lines.join('\n')).not.toContain('0612345678');
  });

  it('logs one write line per save, with key names and no values', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const { win } = setUp();
    await outcome(
      win.fetch(WRITING_BLOCKS, {
        method: 'POST',
        body: save(`write to sam${BS}_lee${BS}@example.com`),
      }),
    );
    await win.fetch(WRITING_BLOCKS, {
      method: 'POST',
      body: save('see you at six'),
    });
    const lines = logLines(info).filter((line) => line.includes('net.write'));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain(
      ' net.write category=writing-block transport=fetch method=POST' +
        ' path=/backend-api/conversation/:id/writing-blocks' +
        ' fields=conversation_id,message_id,updated_at,writing_block,' +
        'writing_block.content,writing_block.metadata,writing_block.variant,' +
        'writing_block.metadata.subject,writing_block.metadata.recipient,' +
        'writing_block.metadata.suggested_followups' +
        ' body=json checked=full result=block',
    );
    expect(lines[1]).toMatch(/ body=json checked=full result=pass$/u);
    const all = logLines(info).join('\n');
    for (const value of ['sam_lee', 'six', 'Housewarming', CONVERSATION]) {
      expect(all).not.toContain(value);
    }
  });
});

describe('other first-party writes', () => {
  const PATH = `/backend-api/conversation/${CONVERSATION}`;

  it('checks an unknown PATCH by its free text', async () => {
    const { win, sent } = setUp();
    expect(
      await outcome(
        win.fetch(PATH, {
          method: 'PATCH',
          body: JSON.stringify({ title: 'Call 07400 123456' }),
        }),
      ),
    ).toBe('blocked');
    expect(
      await outcome(
        win.fetch(PATH, {
          method: 'PATCH',
          body: JSON.stringify({ title: 'Mail sam_lee@example.com' }),
        }),
      ),
    ).toBe('blocked');
    expect(sent).toEqual([]);
  });

  it('passes a PATCH carrying only IDs, tokens and timestamps', async () => {
    const { win, sent, asked } = setUp();
    await win.fetch(PATH, {
      method: 'PATCH',
      body: JSON.stringify({
        conversation_id: CONVERSATION,
        proof_token: 'gAAAAABoQ3x9Zk1lM2V4YW1wbGVfdG9rZW5fdmFsdWU=',
        updated_at: '2026-11-21T10:15:00.000Z',
        ts: '1791981861.681',
        is_archived: true,
      }),
    });
    expect(sent).toEqual(['fetch']);
    // Nothing to verify: no round trip to the isolated side.
    expect(asked).toEqual([]);
  });

  it('decompresses an analytics batch and checks it like any write', async () => {
    const { win, sent, bridge } = setUp();
    const batch = (note: string) =>
      JSON.stringify({
        events: [{ eventName: 'edit', metadata: { note }, time: 1 }],
      });
    expect(
      await outcome(
        win.fetch('https://chatgpt.com/v1/rgstr?gz=1', {
          method: 'POST',
          body: await gzip(batch('call 07400 123456')),
        }),
      ),
    ).toBe('blocked');
    bridge.sync([NINO]);
    // Another site's endpoint: tier 2 on the decompressed text.
    expect(
      await outcome(
        win.fetch('https://telemetry.example/v1/rgstr?gz=1', {
          method: 'POST',
          body: await gzip(batch('ni AB123456C')),
        }),
      ),
    ).toBe('blocked');
    await win.fetch('https://chatgpt.com/v1/rgstr?gz=1', {
      method: 'POST',
      body: await gzip(batch('opened the menu')),
    });
    expect(sent).toEqual(['fetch']);
  });

  it('blocks a first-party write whose gzip body does not decompress', async () => {
    const { win, sent } = setUp();
    const broken = new Uint8Array([0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 3, 1, 2]);
    expect(
      await outcome(
        win.fetch('https://chatgpt.com/v1/rgstr', {
          method: 'POST',
          body: broken,
        }),
      ),
    ).toBe('blocked');
    expect(sent).toEqual([]);
  });

  it('passes genuinely binary first-party bodies (files)', async () => {
    const { win, sent } = setUp();
    await win.fetch('https://chatgpt.com/backend-api/files/upload', {
      method: 'PUT',
      body: new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00]),
    });
    expect(sent).toEqual(['fetch']);
  });

  it('covers XHR, beacon and WebSocket writes with the synchronous email check', () => {
    const { sent, FakeNavigator, Xhr, Ws } = setUp();
    const xhr = new Xhr();
    xhr.open('PATCH', 'https://chatgpt.com/backend-api/x');
    xhr.send(save(`to sam${BS}_lee${BS}@example.com`));
    expect(
      new FakeNavigator().sendBeacon(
        'https://chatgpt.com/ces/v1/t',
        '{"note":"to sam_lee@example.com"}',
      ),
    ).toBe(false);
    new Ws().send('{"text":"to sam_lee@example.com"}');
    expect(sent).toEqual([]);
    // Known limit: without waiting there is no full check, so a phone
    // number not masked before goes through these transports.
    const other = new Xhr();
    other.open('PATCH', 'https://chatgpt.com/backend-api/x');
    other.send(save('Call 07400 123456'));
    expect(sent).toEqual(['xhr']);
  });

  it('leaves requests to other sites to tier 2 only', async () => {
    const { win, sent, asked } = setUp();
    await win.fetch('https://telemetry.example/collect', {
      method: 'POST',
      body: JSON.stringify({ note: 'mail sam_lee@example.com' }),
    });
    expect(sent).toEqual(['fetch']);
    expect(asked).toEqual([]);
  });
});
