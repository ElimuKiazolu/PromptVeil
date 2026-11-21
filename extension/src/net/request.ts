import type { SiteNetRules, WriteSurface } from '@/src/adapters/types.ts';
import { collectJsonStrings, parseJsonText } from '@/src/core/net/checks.ts';
import { unescapeText } from '@/src/core/net/unescape.ts';
import {
  freeTextStrings,
  isFreeText,
  isTokenShaped,
  keyNames,
} from '@/src/core/net/user-text.ts';
import type { BodyContent } from './body.ts';

/** An outgoing request as the net sees it. */
export interface DescribedRequest {
  /** Null when the URL could not be parsed. */
  url: URL | null;
  /** Upper case. */
  method: string;
  body: BodyContent;
}

/** A write to the site itself and the text in it the user may have typed. */
export interface WriteDescription {
  /** A known surface, or 'write' for any other first-party write. */
  readonly surface: WriteSurface | 'write';
  /** On the adapter's skip list: no user text by evidence. */
  readonly skipped: boolean;
  /**
   * The user's text, with the site's escaping undone (markdown backslash
   * escapes, HTML references, Unicode spaces, zero-width characters,
   * full-width forms), each text once.
   */
  readonly user: readonly string[];
  /** Key names of the body for the dev log (no values). */
  readonly fields: readonly string[];
  /** The body was JSON. */
  readonly json: boolean;
}

export interface RequestTexts {
  /** All text the request carries: URL parts, body text and JSON strings. */
  readonly all: readonly string[];
  /** Set for a first-party write; null for any other request. */
  readonly write: WriteDescription | null;
}

/** Decodes %XX sequences byte by byte; never throws on malformed input. */
function percentDecode(text: string): string {
  return text.replace(/%([0-9a-f]{2})/gi, (_match, hex: string) =>
    String.fromCharCode(Number.parseInt(hex, 16)),
  );
}

function urlTexts(url: URL): string[] {
  const out = [url.href, percentDecode(url.pathname), percentDecode(url.hash)];
  if (url.username) out.push(percentDecode(url.username));
  for (const [key, value] of url.searchParams) out.push(key, value);
  return out;
}

export function parseRequestUrl(raw: string, base: string): URL | null {
  return URL.canParse(raw, base) ? new URL(raw, base) : null;
}

/** A path segment printed as is: a lower-case word, or a version (v1). */
const LOGGED_SEGMENT = /^(?:[a-z][a-z_-]{0,31}|v\d{1,2})$/;

/** The path for the dev log, every segment that is not a plain word as :id. */
export function loggedPath(url: URL): string {
  return url.pathname
    .split('/')
    .map((segment) =>
      segment === '' || LOGGED_SEGMENT.test(segment) ? segment : ':id',
    )
    .join('/');
}

/** The user's text in a first-party write. */
function describeWrite(
  request: DescribedRequest,
  url: URL,
  parsed: readonly unknown[],
  rules: SiteNetRules,
): WriteDescription {
  const { method } = request;
  const endpoint = rules.endpoints.find((e) => e.matches(url, method));
  const surface = endpoint?.surface ?? 'write';
  const skipped = rules.skip.some((entry) => entry.matches(url, method));
  const raw: string[] = [];
  const fields: string[] = [];
  let json = false;

  for (const [key, value] of url.searchParams) {
    if (isFreeText(key, value)) raw.push(value);
  }
  request.body.texts.forEach((text, index) => {
    const body = parsed[index];
    if (body !== undefined) {
      json = true;
      // The adapter's fields always count; the free-text selection also
      // reads the rest of the body, so a field the site adds is not missed.
      raw.push(...(endpoint?.userTexts(body) ?? []));
      raw.push(...freeTextStrings(body));
      fields.push(...keyNames(body, endpoint?.loggedObjects));
    } else if (request.body.form) {
      // Keys and values of form bodies, and the encoded form.
      if (isFreeText(null, text)) raw.push(text);
    } else if (!isTokenShaped(text)) {
      // Plain text bodies are text, unless they are a single token.
      raw.push(text);
    }
  });
  const user = [...new Set(raw.map((text) => unescapeText(text).text))];
  return {
    surface,
    skipped,
    user: skipped ? [] : user.filter((text) => text.length > 0),
    fields,
    json,
  };
}

/**
 * All text in the request (URL, raw body, JSON string values), plus the
 * user's text when it is a first-party write.
 */
export function requestTexts(
  request: DescribedRequest,
  rules: SiteNetRules,
): RequestTexts {
  const all: string[] = request.url ? urlTexts(request.url) : [];
  const parsed: unknown[] = [];
  for (const text of request.body.texts) {
    all.push(text);
    const json = parseJsonText(text);
    parsed.push(json);
    if (json !== undefined) all.push(...collectJsonStrings(json));
  }
  const write =
    request.url !== null && rules.isFirstPartyWrite(request.url, request.method)
      ? describeWrite(request, request.url, parsed, rules)
      : null;
  return { all, write };
}
