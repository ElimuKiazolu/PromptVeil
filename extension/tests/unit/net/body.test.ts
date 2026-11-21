import { describe, expect, it } from 'vitest';
import {
  captureCodecs,
  compressionOf,
  MAX_TEXT_BYTES,
  readBodySync,
  readFetchBody,
  type BodyContent,
} from '@/src/net/body.ts';

const codecs = captureCodecs(globalThis);
const encoder = new TextEncoder();

const text = (value: string, encoding: 'gzip' | 'deflate' | null = null) => ({
  texts: [value],
  skipped: null,
  encoding,
  form: false,
});
const skipped = (reason: BodyContent['skipped']): BodyContent => ({
  texts: [],
  skipped: reason,
  encoding: null,
  form: false,
});
const EMPTY: BodyContent = {
  texts: [],
  skipped: null,
  encoding: null,
  form: false,
};

async function compress(
  value: string,
  format: 'gzip' | 'deflate',
): Promise<Uint8Array<ArrayBuffer>> {
  const stream = new Blob([value])
    .stream()
    .pipeThrough(new CompressionStream(format));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** A Statsig-style event batch (fictional values). */
const EVENTS = JSON.stringify({
  events: [
    {
      eventName: 'chatgpt_prompt_edit',
      metadata: { note: 'call me on 07400 123456' },
      time: 1_791_981_861_681,
    },
  ],
  statsigMetadata: { sdkType: 'js-mono' },
});

describe('readBodySync', () => {
  it('reads nothing from an empty body', () => {
    expect(readBodySync(undefined, codecs)).toEqual(EMPTY);
    expect(readBodySync(null, codecs)).toEqual(EMPTY);
  });

  it('reads a string body as is', () => {
    expect(readBodySync('{"a":"b"}', codecs)).toEqual(text('{"a":"b"}'));
  });

  it('reads URL-encoded parameters encoded and decoded', () => {
    const body = readBodySync(
      new URLSearchParams({ email: 'dana@example.com' }),
      codecs,
    );
    expect(body.texts).toEqual([
      'email=dana%40example.com',
      'email',
      'dana@example.com',
    ]);
    expect(body.form).toBe(true);
    expect(body.skipped).toBeNull();
  });

  it('reads the text entries of form data and reports file entries', () => {
    const form = new FormData();
    form.append('note', 'dana@example.com');
    form.append('file', new Blob(['binary']), 'a.bin');
    expect(readBodySync(form, codecs)).toEqual({
      texts: ['note', 'dana@example.com', 'file'],
      skipped: 'file',
      encoding: null,
      form: true,
    });
  });

  it('reads UTF-8 bytes in any byte container', () => {
    const bytes = encoder.encode('{"e":"dana@example.com"}');
    for (const body of [bytes, bytes.buffer, new DataView(bytes.buffer)]) {
      expect(readBodySync(body, codecs)).toEqual(
        text('{"e":"dana@example.com"}'),
      );
    }
  });

  it('reports bytes that are not text as binary', () => {
    expect(readBodySync(new Uint8Array([0xff, 0xfe, 0x00]), codecs)).toEqual(
      skipped('binary'),
    );
  });

  it('reports compressed bytes it cannot wait to decompress', async () => {
    const gzip = await compress(EVENTS, 'gzip');
    expect(readBodySync(gzip, codecs)).toEqual(skipped('compressed'));
  });

  it.each([
    ['Blob', new Blob(['dana@example.com']), 'blob'],
    ['ReadableStream', new ReadableStream(), 'stream'],
  ] as const)('reports a %s body as skipped', (_name, body, reason) => {
    expect(readBodySync(body, codecs)).toEqual(skipped(reason));
  });
});

describe('compressionOf', () => {
  it('recognises gzip and zlib headers', async () => {
    expect(compressionOf(await compress('x', 'gzip'))).toBe('gzip');
    expect(compressionOf(await compress('x', 'deflate'))).toBe('deflate');
  });

  it('does not take ordinary text for compressed data', () => {
    for (const value of ['{"a":1}', 'hello', 'x', '']) {
      expect(compressionOf(encoder.encode(value))).toBeNull();
    }
  });
});

describe('readFetchBody', () => {
  it('reads init.body', async () => {
    expect(
      await readFetchBody('https://x.example/', { body: 'text' }, codecs),
    ).toEqual(text('text'));
  });

  it('reads a Blob whatever its type label', async () => {
    const json = new Blob(['{"e":"dana@example.com"}'], {
      type: 'application/json',
    });
    const labelled = new Blob(['{"e":"dana@example.com"}'], {
      type: 'application/octet-stream',
    });
    for (const body of [json, labelled]) {
      expect(
        await readFetchBody('https://x.example/', { body }, codecs),
      ).toEqual(text('{"e":"dana@example.com"}'));
    }
  });

  it('reports a Blob that is not text as binary', async () => {
    const blob = new Blob([new Uint8Array([0xff, 0xd8, 0xff])], {
      type: 'image/jpeg',
    });
    expect(
      await readFetchBody('https://x.example/', { body: blob }, codecs),
    ).toEqual(skipped('binary'));
  });

  it.each(['gzip', 'deflate'] as const)(
    'decompresses a %s byte body, as analytics batches are sent',
    async (format) => {
      const bytes = await compress(EVENTS, format);
      expect(
        await readFetchBody(
          'https://chatgpt.com/v1/rgstr?gz=1',
          { method: 'POST', body: bytes },
          codecs,
        ),
      ).toEqual(text(EVENTS, format));
      expect(
        await readFetchBody(
          'https://chatgpt.com/v1/rgstr',
          { method: 'POST', body: new Blob([bytes as BlobPart]) },
          codecs,
        ),
      ).toEqual(text(EVENTS, format));
    },
  );

  it('reports a gzip header that does not decompress as corrupt', async () => {
    const bytes = await compress(EVENTS, 'gzip');
    const broken = bytes.slice(0, 20);
    expect(
      await readFetchBody('https://x.example/', { body: broken }, codecs),
    ).toEqual(skipped('corrupt'));
  });

  it('reads text that only starts like a zlib header as text', async () => {
    // "x^" passes the two-byte zlib header check.
    expect(compressionOf(encoder.encode('x^2 + y'))).toBe('deflate');
    expect(
      await readFetchBody(
        'https://x.example/',
        { body: encoder.encode('x^2 + y') },
        codecs,
      ),
    ).toEqual(text('x^2 + y'));
  });

  it('stops decompressing past the size limit', async () => {
    const big = 'a'.repeat(MAX_TEXT_BYTES + 10);
    const bytes = await compress(big, 'gzip');
    expect(
      await readFetchBody('https://x.example/', { body: bytes }, codecs),
    ).toEqual(skipped('too-large'));
  });

  it('tells a large text body from a large binary one', async () => {
    const largeText = new Blob(['a'.repeat(MAX_TEXT_BYTES + 1)]);
    const largeBinary = new Blob([
      new Uint8Array(MAX_TEXT_BYTES + 1).fill(0xff),
    ]);
    expect(
      await readFetchBody('https://x.example/', { body: largeText }, codecs),
    ).toEqual(skipped('too-large'));
    expect(
      await readFetchBody('https://x.example/', { body: largeBinary }, codecs),
    ).toEqual(skipped('binary'));
  });

  it('reads a Request body without consuming it', async () => {
    const request = new Request('https://x.example/', {
      method: 'POST',
      body: 'dana@example.com',
      headers: { 'content-type': 'text/plain' },
    });
    expect(await readFetchBody(request, undefined, codecs)).toEqual(
      text('dana@example.com'),
    );
    expect(request.bodyUsed).toBe(false);
    expect(await request.text()).toBe('dana@example.com');
  });

  it('reads a compressed Request body', async () => {
    const request = new Request('https://x.example/', {
      method: 'POST',
      body: await compress(EVENTS, 'gzip'),
    });
    expect(await readFetchBody(request, undefined, codecs)).toEqual(
      text(EVENTS, 'gzip'),
    );
  });

  it('reports a binary Request body', async () => {
    const request = new Request('https://x.example/', {
      method: 'POST',
      body: new Uint8Array([0xff, 0xfe]),
      headers: { 'content-type': 'application/octet-stream' },
    });
    expect(await readFetchBody(request, undefined, codecs)).toEqual(
      skipped('binary'),
    );
  });

  it('prefers init.body over the Request body', async () => {
    const request = new Request('https://x.example/', {
      method: 'POST',
      body: 'ignored',
    });
    expect(await readFetchBody(request, { body: 'used' }, codecs)).toEqual(
      text('used'),
    );
  });

  it('reads nothing from a GET', async () => {
    expect(
      await readFetchBody('https://x.example/', undefined, codecs),
    ).toEqual(EMPTY);
  });

  it('uses the functions captured at start, not later replacements', async () => {
    const captured = captureCodecs(globalThis);
    const replaced = Object.getOwnPropertyDescriptor(
      Blob.prototype,
      'arrayBuffer',
    );
    Object.defineProperty(Blob.prototype, 'arrayBuffer', {
      configurable: true,
      value: () => Promise.resolve(new ArrayBuffer(0)),
    });
    try {
      expect(
        await readFetchBody(
          'https://x.example/',
          { body: new Blob(['dana@example.com']) },
          captured,
        ),
      ).toEqual(text('dana@example.com'));
    } finally {
      if (replaced)
        Object.defineProperty(Blob.prototype, 'arrayBuffer', replaced);
    }
  });
});
