/**
 * Vault conversation IDs: `{site}:{id}` for a conversation the site has
 * named, `{site}:pending:{uuid}` for a new chat before its first reply gives
 * it an ID. A pending ID belongs to one tab and is never reused.
 */
import type { SiteId } from './settings.ts';

/** IDs each site uses in its URLs. ChatGPT: UUIDs and older shorter forms. */
const SITE_ID_FORMATS: Partial<Record<SiteId, RegExp>> = {
  chatgpt: /^[A-Za-z0-9-]{8,128}$/,
};

const PENDING = 'pending';

/** crypto.randomUUID() output (version 4, lower case). */
const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export type ParsedConversationId =
  | { site: SiteId; kind: 'active'; siteConversationId: string }
  | { site: SiteId; kind: 'pending'; uuid: string };

function isSiteId(value: string): value is SiteId {
  return Object.hasOwn(SITE_ID_FORMATS, value);
}

/** The parts of a well-formed vault conversation ID, or null. */
export function parseConversationId(
  value: unknown,
): ParsedConversationId | null {
  if (typeof value !== 'string') return null;
  const colon = value.indexOf(':');
  if (colon < 0) return null;
  const site = value.slice(0, colon);
  const rest = value.slice(colon + 1);
  if (!isSiteId(site)) return null;
  if (rest.startsWith(`${PENDING}:`)) {
    const uuid = rest.slice(PENDING.length + 1);
    return UUID_V4.test(uuid) ? { site, kind: 'pending', uuid } : null;
  }
  return SITE_ID_FORMATS[site]?.test(rest)
    ? { site, kind: 'active', siteConversationId: rest }
    : null;
}

/** True when `id` is an ID this site could put in its URL. */
export function isSiteConversationId(site: SiteId, id: string): boolean {
  return SITE_ID_FORMATS[site]?.test(id) ?? false;
}

export function activeConversationId(site: SiteId, id: string): string {
  return `${site}:${id}`;
}

export function pendingConversationId(site: SiteId, uuid: string): string {
  return `${site}:${PENDING}:${uuid}`;
}
