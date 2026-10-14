/**
 * Messages between the isolated content script and the MAIN-world request
 * safety net. Both share only the page's DOM, so every message travels as a
 * DOM event the page could in principle see.
 *
 * Handshake: at document_start, before the page has any element a script
 * could run from, the isolated side sends a random key and the MAIN side
 * confirms. Both sides accept handshake messages only during that window, so
 * the key is never visible to page scripts and cannot be replaced later.
 * After the handshake every message uses event names that contain the key,
 * which the page can neither listen to nor forge.
 *
 * Operations are additive only: nothing can turn the net off or remove what
 * it blocks.
 */
import { HASH_KEY_PATTERN } from '@/src/core/net/hash.ts';

export const NET_MAIN_HELLO = 'promptveil:net-main-hello';
export const NET_KEY_OFFER = 'promptveil:net-key-offer';

export type NetChannelMessage = 'ready' | 'add' | 'report';

export function netChannelEvent(
  key: string,
  message: NetChannelMessage,
): string {
  return `promptveil:${key}:${message}`;
}

/**
 * True only during the content-script phase of document_start: the parser
 * has not yet created any element, so no page script can have run.
 */
export function isHandshakeWindowOpen(doc: Document): boolean {
  // Open while there is no root element yet, or the root has no children.
  return !doc.firstElementChild?.firstElementChild;
}

export function isValidKey(value: unknown): value is string {
  return typeof value === 'string' && HASH_KEY_PATTERN.test(value);
}

/** Values to add to the net's block lists. */
export interface NetAddition {
  /** Keyed hashes of normalised real values. */
  hashes: string[];
  /** Stand-ins issued in this tab (not secret: they are what is sent). */
  standIns: string[];
}

const HASH_PATTERN = /^[0-9a-f]{64}$/;
const MAX_ITEMS = 10_000;

function stringArray(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > MAX_ITEMS) return null;
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') return null;
    out.push(item);
  }
  return out;
}

export function parseAddition(detail: unknown): NetAddition | null {
  if (typeof detail !== 'string') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(detail);
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  const hashes = stringArray(record.hashes);
  const standIns = stringArray(record.standIns);
  if (!hashes || !standIns) return null;
  if (!hashes.every((h) => HASH_PATTERN.test(h))) return null;
  return { hashes, standIns };
}

export type NetTransport = 'fetch' | 'xhr' | 'websocket' | 'beacon';
export type NetCategory = 'message' | 'other';

/** What the net reports back; fixed codes only, never request content. */
export type NetReport =
  | {
      event: 'net.blocked';
      tier: 1 | 2;
      category: NetCategory;
      transport: NetTransport;
    }
  | {
      event: 'net.skipped-binary';
      category: NetCategory;
      transport: NetTransport;
    }
  | { event: 'net.checked'; category: NetCategory; transport: NetTransport }
  | { event: 'net.failed'; category: NetCategory; transport: NetTransport };

const TRANSPORTS: readonly string[] = ['fetch', 'xhr', 'websocket', 'beacon'];
const CATEGORIES: readonly string[] = ['message', 'other'];

export function parseReport(detail: unknown): NetReport | null {
  if (typeof detail !== 'string') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(detail);
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const r = parsed as Record<string, unknown>;
  const transport = r.transport;
  const category = r.category;
  if (typeof transport !== 'string' || !TRANSPORTS.includes(transport))
    return null;
  if (typeof category !== 'string' || !CATEGORIES.includes(category))
    return null;
  const base = {
    transport: transport as NetTransport,
    category: category as NetCategory,
  };
  if (r.event === 'net.blocked' && (r.tier === 1 || r.tier === 2)) {
    return { event: 'net.blocked', tier: r.tier, ...base };
  }
  if (r.event === 'net.skipped-binary')
    return { event: 'net.skipped-binary', ...base };
  if (r.event === 'net.checked') return { event: 'net.checked', ...base };
  if (r.event === 'net.failed') return { event: 'net.failed', ...base };
  return null;
}
