/** Text carried by a request body, and whether any part could not be read. */
export interface BodyContent {
  texts: string[];
  /** A binary or stream part was present and not inspected. */
  skippedBinary: boolean;
}

const EMPTY: BodyContent = { texts: [], skippedBinary: false };
const SKIPPED: BodyContent = { texts: [], skippedBinary: true };

/** Text bodies larger than this are not read (and reported as skipped). */
const MAX_TEXT_BYTES = 5_000_000;

function isTextType(type: string): boolean {
  const t = type.toLowerCase();
  return (
    t === '' ||
    t.startsWith('text/') ||
    t.includes('json') ||
    t.includes('xml') ||
    t.includes('javascript') ||
    t.includes('x-www-form-urlencoded')
  );
}

function paramTexts(params: URLSearchParams): string[] {
  // The encoded form and every decoded key and value.
  const out = [params.toString()];
  for (const [key, value] of params) out.push(key, value);
  return out;
}

/**
 * Body text readable without waiting: strings, URL-encoded parameters and the
 * text entries of form data. Blobs, buffers and streams cannot be read
 * synchronously and are reported as skipped.
 */
export function readBodySync(body: unknown): BodyContent {
  if (body === null || body === undefined) return EMPTY;
  if (typeof body === 'string') return { texts: [body], skippedBinary: false };
  if (body instanceof URLSearchParams) {
    return { texts: paramTexts(body), skippedBinary: false };
  }
  if (body instanceof FormData) {
    const texts: string[] = [];
    let skippedBinary = false;
    for (const [key, value] of body.entries()) {
      texts.push(key);
      if (typeof value === 'string') texts.push(value);
      else skippedBinary = true;
    }
    return { texts, skippedBinary };
  }
  return SKIPPED;
}

async function readBlob(blob: Blob): Promise<BodyContent> {
  if (!isTextType(blob.type) || blob.size > MAX_TEXT_BYTES) return SKIPPED;
  return { texts: [await blob.text()], skippedBinary: false };
}

/** Body text of a fetch call, reading Blob and Request bodies as text. */
export async function readFetchBody(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<BodyContent> {
  const body = init?.body;
  if (body !== undefined && body !== null) {
    return body instanceof Blob ? readBlob(body) : readBodySync(body);
  }
  if (input instanceof Request && input.body !== null) {
    const type = input.headers.get('content-type') ?? '';
    if (!isTextType(type)) return SKIPPED;
    // Read a copy, so the page's request body stays unread.
    return { texts: [await input.clone().text()], skippedBinary: false };
  }
  return EMPTY;
}
