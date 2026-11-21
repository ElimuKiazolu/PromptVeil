/**
 * Reading request bodies as text for the safety net.
 *
 * Byte bodies (ArrayBuffer, typed arrays, Blobs, Request bodies) are read
 * too: compressed ones (gzip or zlib, recognised by their first bytes, the
 * way analytics clients send them) are decompressed where waiting is
 * possible (fetch), then any body that is valid UTF-8 is checked as text.
 * What cannot be read is reported with its reason, never ignored silently.
 */

/** Why a body, or part of it, was not read. */
export type SkipReason =
  /** Bytes that are not UTF-8 text (images, files). */
  | 'binary'
  /** Compressed bytes on a path that cannot wait to decompress them. */
  | 'compressed'
  /** Decompression failed: the bytes are not what their header says. */
  | 'corrupt'
  /**
   * Text (or compressed bytes) larger than MAX_TEXT_BYTES, before or after
   * decompressing. Larger bodies that are neither are 'binary'.
   */
  | 'too-large'
  /** A Blob on a path that cannot wait to read it. */
  | 'blob'
  /** A stream body, which cannot be read without consuming it. */
  | 'stream'
  /** A file entry of form data. */
  | 'file';

export type BodyEncoding = 'gzip' | 'deflate';

/** Text carried by a request body, and what could not be read. */
export interface BodyContent {
  texts: string[];
  /** Why part of the body was not read; null when all of it was. */
  skipped: SkipReason | null;
  /** Compression undone to read the body. */
  encoding: BodyEncoding | null;
  /** URL-encoded parameters or form data (texts are keys and values). */
  form: boolean;
}

const EMPTY: BodyContent = {
  texts: [],
  skipped: null,
  encoding: null,
  form: false,
};

const skippedBody = (reason: SkipReason): BodyContent => ({
  texts: [],
  skipped: reason,
  encoding: null,
  form: false,
});

const textBody = (
  text: string,
  encoding: BodyEncoding | null = null,
): BodyContent => ({ texts: [text], skipped: null, encoding, form: false });

/** Bodies larger than this, before or after decompressing, are not read. */
export const MAX_TEXT_BYTES = 5_000_000;

/**
 * The platform functions body reading uses, captured when the net starts
 * (document_start, before any page script), so later changes the page makes
 * to these globals do not reach the net.
 */
export interface BodyCodecs {
  /** UTF-8 text of the bytes, or null when they are not valid UTF-8. */
  decodeUtf8(bytes: Uint8Array): string | null;
  /** The bytes of a Blob, or of its first `limit` bytes. */
  blobBytes(blob: Blob, limit?: number): Promise<Uint8Array>;
  /** A Request's body bytes, read from a copy (the page's stays unread). */
  requestBytes(request: Request): Promise<Uint8Array>;
  /**
   * Decompressed bytes, or 'too-large' past `limit`; rejects on corrupt
   * input. Null when the platform cannot decompress.
   */
  decompress:
    | ((
        bytes: Uint8Array,
        format: BodyEncoding,
        limit: number,
      ) => Promise<Uint8Array | 'too-large'>)
    | null;
}

/** The globals captureCodecs needs. */
export interface CodecGlobals {
  TextDecoder: typeof TextDecoder;
  Blob: typeof Blob;
  Request: typeof Request;
  ReadableStream: typeof ReadableStream;
  DecompressionStream?: typeof DecompressionStream;
}

function method<T extends object, K extends keyof T>(
  proto: T,
  name: K,
): T[K] & ((...args: never[]) => unknown) {
  const value = proto[name];
  if (typeof value !== 'function') {
    throw new TypeError(`${String(name)} is not a function`);
  }
  return value as T[K] & ((...args: never[]) => unknown);
}

export function captureCodecs(globals: CodecGlobals): BodyCodecs {
  const decoder = new globals.TextDecoder('utf-8', { fatal: true });
  const decode = method(globals.TextDecoder.prototype, 'decode');
  const blobArrayBuffer = method(globals.Blob.prototype, 'arrayBuffer');
  const blobSlice = method(globals.Blob.prototype, 'slice');
  const requestClone = method(globals.Request.prototype, 'clone');
  const requestArrayBuffer = method(globals.Request.prototype, 'arrayBuffer');
  const pipeThrough = method(globals.ReadableStream.prototype, 'pipeThrough');
  const getReader = method(globals.ReadableStream.prototype, 'getReader');
  const Stream = globals.ReadableStream;
  const Decompression = globals.DecompressionStream;

  const toBytes = (buffer: unknown): Uint8Array => {
    if (!(buffer instanceof ArrayBuffer)) {
      throw new TypeError('not an ArrayBuffer');
    }
    return new Uint8Array(buffer);
  };

  return {
    decodeUtf8(bytes) {
      try {
        return Reflect.apply(decode, decoder, [bytes]) as string;
      } catch (error) {
        // A fatal decoder throws TypeError for bytes that are not UTF-8.
        if (error instanceof TypeError) return null;
        throw error;
      }
    },
    async blobBytes(blob, limit) {
      const part: unknown =
        limit === undefined ? blob : Reflect.apply(blobSlice, blob, [0, limit]);
      return toBytes(await Reflect.apply(blobArrayBuffer, part, []));
    },
    async requestBytes(request) {
      const copy: unknown = Reflect.apply(requestClone, request, []);
      return toBytes(await Reflect.apply(requestArrayBuffer, copy, []));
    },
    decompress:
      Decompression === undefined
        ? null
        : async (bytes, format, limit) => {
            const input = new Stream<Uint8Array>({
              start(controller) {
                controller.enqueue(bytes);
                controller.close();
              },
            });
            const output = Reflect.apply(pipeThrough, input, [
              new Decompression(format),
            ]) as ReadableStream<Uint8Array>;
            const reader = Reflect.apply(
              getReader,
              output,
              [],
            ) as ReadableStreamDefaultReader<Uint8Array>;
            const chunks: Uint8Array[] = [];
            let size = 0;
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              size += value.byteLength;
              if (size > limit) {
                await reader.cancel();
                return 'too-large';
              }
              chunks.push(value);
            }
            const out = new Uint8Array(size);
            let offset = 0;
            for (const chunk of chunks) {
              out.set(chunk, offset);
              offset += chunk.byteLength;
            }
            return out;
          },
  };
}

/**
 * The compression a body's first bytes announce: gzip (1f 8b) or zlib
 * (a deflate header whose check bits hold, RFC 1950).
 */
export function compressionOf(bytes: Uint8Array): BodyEncoding | null {
  const first = bytes[0];
  const second = bytes[1];
  if (first === undefined || second === undefined) return null;
  // ID1 ID2 and CM 8 (deflate), RFC 1952.
  if (first === 0x1f && second === 0x8b && bytes[2] === 8) return 'gzip';
  // CMF: method 8 (deflate), window ≤ 32 KiB; FCHECK makes CMF·256+FLG a
  // multiple of 31; no preset dictionary.
  if (
    (first & 0x0f) === 8 &&
    first >> 4 <= 7 &&
    (first * 256 + second) % 31 === 0 &&
    (second & 0x20) === 0
  ) {
    return 'deflate';
  }
  return null;
}

/** Bytes read from the start of a large body to tell text from binary. */
const HEAD_BYTES = 4096;

/**
 * Why a body over MAX_TEXT_BYTES is not read: 'too-large' when its start is
 * compressed or UTF-8 text (it could carry typed text), else 'binary'.
 */
function largeBody(head: Uint8Array, codecs: BodyCodecs): BodyContent {
  if (compressionOf(head) !== null) return skippedBody('too-large');
  // The cut may split a character: allow up to three bytes to be dropped.
  for (let cut = 0; cut <= 3 && cut < head.byteLength; cut += 1) {
    if (codecs.decodeUtf8(head.subarray(0, head.byteLength - cut)) !== null) {
      return skippedBody('too-large');
    }
  }
  return skippedBody('binary');
}

function paramTexts(params: URLSearchParams): string[] {
  // The encoded form and every decoded key and value.
  const out = [params.toString()];
  for (const [key, value] of params) out.push(key, value);
  return out;
}

function bytesOf(body: unknown): Uint8Array | null {
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  if (ArrayBuffer.isView(body)) {
    return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
  }
  return null;
}

/** Text of bytes read without waiting: compressed bytes cannot be. */
function bytesSync(bytes: Uint8Array, codecs: BodyCodecs): BodyContent {
  if (bytes.byteLength > MAX_TEXT_BYTES) {
    return largeBody(bytes.subarray(0, HEAD_BYTES), codecs);
  }
  if (compressionOf(bytes) !== null) return skippedBody('compressed');
  const text = codecs.decodeUtf8(bytes);
  return text === null ? skippedBody('binary') : textBody(text);
}

/** Text of bytes, decompressing them first when they are compressed. */
async function bytesAsync(
  bytes: Uint8Array,
  codecs: BodyCodecs,
): Promise<BodyContent> {
  if (bytes.byteLength > MAX_TEXT_BYTES) {
    return largeBody(bytes.subarray(0, HEAD_BYTES), codecs);
  }
  const encoding = compressionOf(bytes);
  if (encoding === null) return bytesSync(bytes, codecs);
  if (codecs.decompress === null) return skippedBody('compressed');
  let plain: Uint8Array | 'too-large';
  try {
    plain = await codecs.decompress(bytes, encoding, MAX_TEXT_BYTES);
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    // A gzip header is unmistakable: bytes that fail after it are not
    // what they claim, and may still be read by the server. The two-byte
    // zlib header also starts ordinary text ("x^…"): read those as they are.
    if (encoding === 'gzip') return skippedBody('corrupt');
    const text = codecs.decodeUtf8(bytes);
    return text === null ? skippedBody('binary') : textBody(text);
  }
  if (plain === 'too-large') return skippedBody('too-large');
  const text = codecs.decodeUtf8(plain);
  return text === null ? skippedBody('binary') : textBody(text, encoding);
}

/**
 * Body text readable without waiting: strings, URL-encoded parameters, the
 * text entries of form data and uncompressed UTF-8 bytes. Blobs, streams and
 * compressed bytes cannot be read synchronously and are reported as skipped.
 */
export function readBodySync(body: unknown, codecs: BodyCodecs): BodyContent {
  if (body === null || body === undefined) return EMPTY;
  if (typeof body === 'string') return textBody(body);
  if (body instanceof URLSearchParams) {
    return {
      texts: paramTexts(body),
      skipped: null,
      encoding: null,
      form: true,
    };
  }
  if (body instanceof FormData) {
    const texts: string[] = [];
    let skipped: SkipReason | null = null;
    for (const [key, value] of body.entries()) {
      texts.push(key);
      if (typeof value === 'string') texts.push(value);
      else skipped = 'file';
    }
    return { texts, skipped, encoding: null, form: true };
  }
  const bytes = bytesOf(body);
  if (bytes !== null) return bytesSync(bytes, codecs);
  if (body instanceof Blob) return skippedBody('blob');
  return skippedBody('stream');
}

/** A Blob's text, whatever its type label (the label is the page's choice). */
async function readBlob(blob: Blob, codecs: BodyCodecs): Promise<BodyContent> {
  if (blob.size > MAX_TEXT_BYTES) {
    return largeBody(await codecs.blobBytes(blob, HEAD_BYTES), codecs);
  }
  return bytesAsync(await codecs.blobBytes(blob), codecs);
}

/** Body text of a fetch call, reading Blob, byte and Request bodies. */
export async function readFetchBody(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  codecs: BodyCodecs,
): Promise<BodyContent> {
  const body = init?.body;
  if (body !== undefined && body !== null) {
    if (body instanceof Blob) return readBlob(body, codecs);
    const bytes = bytesOf(body);
    if (bytes !== null) return bytesAsync(bytes, codecs);
    return readBodySync(body, codecs);
  }
  if (input instanceof Request && input.body !== null) {
    return bytesAsync(await codecs.requestBytes(input), codecs);
  }
  return EMPTY;
}
