import type { SiteNetRules } from '@/src/adapters/types.ts';
import {
  collectJsonStrings,
  parseJsonText,
  type RequestTexts,
} from '@/src/core/net/checks.ts';
import type { BodyContent } from './body.ts';

/** An outgoing request as the net sees it. */
export interface DescribedRequest {
  /** Null when the URL could not be parsed. */
  url: URL | null;
  method: string;
  body: BodyContent;
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

/**
 * All text in the request (URL, raw body, JSON string values), plus the
 * message text when it goes to one of the site's message endpoints.
 */
export function requestTexts(
  request: DescribedRequest,
  rules: SiteNetRules,
): RequestTexts {
  const all: string[] = request.url ? urlTexts(request.url) : [];
  const isMessage =
    request.url !== null &&
    rules.isMessageEndpoint(request.url, request.method);
  const message: string[] = [];

  for (const text of request.body.texts) {
    all.push(text);
    const json = parseJsonText(text);
    if (json !== undefined) all.push(...collectJsonStrings(json));
    if (isMessage) {
      // An unexpected body shape is checked in full rather than skipped.
      const texts =
        json === undefined
          ? [text]
          : (rules.messageTexts(json) ?? collectJsonStrings(json));
      message.push(...texts);
    }
  }
  return { all, message: isMessage ? message : null };
}
