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
 *
 * Message requests sent with fetch are also verified by the isolated side:
 * the net sends the message text fields ('verify') and waits for a verdict
 * ('verdict'); no verdict in time blocks the request.
 */
import { HASH_KEY_PATTERN } from '@/src/core/net/hash.ts';

export const NET_MAIN_HELLO = 'promptveil:net-main-hello';
export const NET_KEY_OFFER = 'promptveil:net-key-offer';

export type NetChannelMessage =
  'ready' | 'add' | 'report' | 'verify' | 'verdict';

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

/** One form of a masked value (see src/core/net/forms.ts), keyed. */
export interface NetForm {
  /** Length of the compact form. */
  length: number;
  /** Keyed rolling value (pre-check). */
  roll: number;
  /** Keyed HMAC-SHA-256 of the compact form. */
  hash: string;
}

/** Values to add to the net's block lists. */
export interface NetAddition {
  forms: NetForm[];
  /** Email stand-ins issued in this tab (not secret: they are what is sent). */
  standIns: string[];
}

/** Message text the net asks the isolated side to verify. */
export interface NetVerifyRequest {
  id: number;
  texts: string[];
}

export interface NetVerdict {
  id: number;
  /** True when the text holds a value that should have been masked. */
  block: boolean;
}

const HASH_PATTERN = /^[0-9a-f]{64}$/;
const MAX_ITEMS = 10_000;
/** Longest compact form accepted (a PEM block fits). */
const MAX_FORM_LENGTH = 16_384;
const MAX_ROLL = 2_147_483_647;

function stringArray(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > MAX_ITEMS) return null;
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') return null;
    out.push(item);
  }
  return out;
}

function parseObject(detail: unknown): Record<string, unknown> | null {
  if (typeof detail !== 'string') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(detail);
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
  return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : null;
}

function isWholeNumber(value: unknown, min: number, max: number): boolean {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= min &&
    value <= max
  );
}

function isNetForm(value: unknown): value is NetForm {
  if (typeof value !== 'object' || value === null) return false;
  const form = value as Record<string, unknown>;
  return (
    isWholeNumber(form.length, 1, MAX_FORM_LENGTH) &&
    isWholeNumber(form.roll, 0, MAX_ROLL - 1) &&
    typeof form.hash === 'string' &&
    HASH_PATTERN.test(form.hash)
  );
}

export function parseAddition(detail: unknown): NetAddition | null {
  const record = parseObject(detail);
  if (record === null) return null;
  const { forms } = record;
  const standIns = stringArray(record.standIns);
  if (!Array.isArray(forms) || forms.length > MAX_ITEMS || !standIns) {
    return null;
  }
  if (!forms.every(isNetForm)) return null;
  return { forms, standIns };
}

export function parseVerifyRequest(detail: unknown): NetVerifyRequest | null {
  const record = parseObject(detail);
  if (
    record === null ||
    !isWholeNumber(record.id, 0, Number.MAX_SAFE_INTEGER)
  ) {
    return null;
  }
  const texts = stringArray(record.texts);
  return texts === null ? null : { id: record.id as number, texts };
}

export function parseVerdict(detail: unknown): NetVerdict | null {
  const record = parseObject(detail);
  if (
    record === null ||
    !isWholeNumber(record.id, 0, Number.MAX_SAFE_INTEGER) ||
    typeof record.block !== 'boolean'
  ) {
    return null;
  }
  return { id: record.id as number, block: record.block };
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
  | { event: 'net.failed'; category: NetCategory; transport: NetTransport }
  /** How many masked-value forms the net now holds (diagnostic). */
  | { event: 'net.added'; count: number }
  /** A message request verified by the isolated side: added time, outcome. */
  | { event: 'net.verified'; ms: number; block: boolean };

const TRANSPORTS: readonly string[] = ['fetch', 'xhr', 'websocket', 'beacon'];
const CATEGORIES: readonly string[] = ['message', 'other'];

export function parseReport(detail: unknown): NetReport | null {
  const r = parseObject(detail);
  if (r === null) return null;
  if (r.event === 'net.verified') {
    const { ms, block } = r;
    return typeof ms === 'number' &&
      Number.isFinite(ms) &&
      ms >= 0 &&
      typeof block === 'boolean'
      ? { event: 'net.verified', ms, block }
      : null;
  }
  if (r.event === 'net.added') {
    const { count } = r;
    return typeof count === 'number' && Number.isInteger(count) && count >= 0
      ? { event: 'net.added', count }
      : null;
  }
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
