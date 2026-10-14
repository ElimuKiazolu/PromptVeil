import { describe, expect, it } from 'vitest';
import { readBodySync, readFetchBody } from '@/src/net/body.ts';

describe('readBodySync', () => {
  it('reads nothing from an empty body', () => {
    expect(readBodySync(undefined)).toEqual({
      texts: [],
      skippedBinary: false,
    });
    expect(readBodySync(null)).toEqual({ texts: [], skippedBinary: false });
  });

  it('reads a string body as is', () => {
    expect(readBodySync('{"a":"b"}')).toEqual({
      texts: ['{"a":"b"}'],
      skippedBinary: false,
    });
  });

  it('reads URL-encoded parameters encoded and decoded', () => {
    const body = readBodySync(
      new URLSearchParams({ email: 'dana@example.com' }),
    );
    expect(body.texts).toEqual([
      'email=dana%40example.com',
      'email',
      'dana@example.com',
    ]);
    expect(body.skippedBinary).toBe(false);
  });

  it('reads the text entries of form data and reports file entries', () => {
    const form = new FormData();
    form.append('note', 'dana@example.com');
    form.append('file', new Blob(['binary']), 'a.bin');
    expect(readBodySync(form)).toEqual({
      texts: ['note', 'dana@example.com', 'file'],
      skippedBinary: true,
    });
  });

  it.each([
    ['Blob', new Blob(['dana@example.com'])],
    ['ArrayBuffer', new ArrayBuffer(8)],
    ['Uint8Array', new Uint8Array([1, 2, 3])],
    ['ReadableStream', new ReadableStream()],
  ])('reports a %s body as skipped', (_name, body) => {
    expect(readBodySync(body)).toEqual({ texts: [], skippedBinary: true });
  });
});

describe('readFetchBody', () => {
  it('reads init.body', async () => {
    expect(await readFetchBody('https://x.example/', { body: 'text' })).toEqual(
      {
        texts: ['text'],
        skippedBinary: false,
      },
    );
  });

  it('reads a text Blob in init.body', async () => {
    const blob = new Blob(['{"e":"dana@example.com"}'], {
      type: 'application/json',
    });
    expect(await readFetchBody('https://x.example/', { body: blob })).toEqual({
      texts: ['{"e":"dana@example.com"}'],
      skippedBinary: false,
    });
  });

  it('skips a binary Blob', async () => {
    const blob = new Blob([new Uint8Array([1, 2])], { type: 'image/png' });
    expect(await readFetchBody('https://x.example/', { body: blob })).toEqual({
      texts: [],
      skippedBinary: true,
    });
  });

  it('reads a Request body without consuming it', async () => {
    const request = new Request('https://x.example/', {
      method: 'POST',
      body: 'dana@example.com',
      headers: { 'content-type': 'text/plain' },
    });
    expect(await readFetchBody(request)).toEqual({
      texts: ['dana@example.com'],
      skippedBinary: false,
    });
    expect(request.bodyUsed).toBe(false);
    expect(await request.text()).toBe('dana@example.com');
  });

  it('skips a binary Request body', async () => {
    const request = new Request('https://x.example/', {
      method: 'POST',
      body: new Uint8Array([1, 2]),
      headers: { 'content-type': 'application/octet-stream' },
    });
    expect(await readFetchBody(request)).toEqual({
      texts: [],
      skippedBinary: true,
    });
  });

  it('prefers init.body over the Request body', async () => {
    const request = new Request('https://x.example/', {
      method: 'POST',
      body: 'ignored',
    });
    expect(await readFetchBody(request, { body: 'used' })).toEqual({
      texts: ['used'],
      skippedBinary: false,
    });
  });

  it('reads nothing from a GET', async () => {
    expect(await readFetchBody('https://x.example/')).toEqual({
      texts: [],
      skippedBinary: false,
    });
  });
});
