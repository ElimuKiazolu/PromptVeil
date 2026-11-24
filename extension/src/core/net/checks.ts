import { detectEmails } from '../detect/rules/email.ts';
import { compactForm } from './compact.ts';
import { normaliseValue, type FormHasher } from './hash.ts';
import type { RollingHash } from './rolling.ts';
import { unescapeText } from './unescape.ts';
import { MAX_BLOCKED_FORMS } from '../../shared/net-protocol.ts';

export type NetTier = 1 | 2;

/**
 * A blocked request says what it carried, for the notice (never values):
 * tier 1 the number of emails that are not stand-ins, tier 2 the keyed
 * hashes of the masked-value forms found (at most MAX_BLOCKED_FORMS).
 */
export type NetVerdict =
  | { block: false }
  | { block: true; tier: 1; emails: number }
  | { block: true; tier: 2; forms: readonly string[] };

const ALLOW: NetVerdict = { block: false };

/** Nesting deeper than this is not followed; such bodies are not normal. */
const MAX_JSON_DEPTH = 64;

/**
 * Every string value inside a parsed JSON value, in document order; object
 * keys are not included.
 */
export function collectJsonValues(value: unknown): string[] {
  const out: string[] = [];
  const stack: { value: unknown; depth: number }[] = [{ value, depth: 0 }];
  while (stack.length > 0) {
    const item = stack.pop();
    if (!item) break;
    const current = item.value;
    if (typeof current === 'string') {
      out.push(current);
    } else if (
      typeof current === 'object' &&
      current !== null &&
      item.depth < MAX_JSON_DEPTH
    ) {
      const children = Array.isArray(current)
        ? (current as unknown[])
        : Object.values(current);
      // Pushed last to first, so they come off the stack in order.
      for (let i = children.length - 1; i >= 0; i -= 1) {
        stack.push({ value: children[i], depth: item.depth + 1 });
      }
    }
  }
  return out;
}

/** Every string value (and object key) inside a parsed JSON value. */
export function collectJsonStrings(value: unknown): string[] {
  const out: string[] = [];
  const stack: { value: unknown; depth: number }[] = [{ value, depth: 0 }];
  while (stack.length > 0) {
    const item = stack.pop();
    if (!item) break;
    const current = item.value;
    if (typeof current === 'string') {
      out.push(current);
    } else if (
      typeof current === 'object' &&
      current !== null &&
      item.depth < MAX_JSON_DEPTH
    ) {
      const entries = Array.isArray(current)
        ? current.map((v: unknown) => ['', v] as const)
        : Object.entries(current);
      for (const [key, child] of entries) {
        if (key !== '') out.push(key);
        stack.push({ value: child, depth: item.depth + 1 });
      }
    }
  }
  return out;
}

/** Parses text that looks like JSON; undefined if it is not JSON. */
export function parseJsonText(text: string): unknown {
  const first = text.trimStart().charAt(0);
  if (first !== '{' && first !== '[') return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
}

/** How the net recognises the forms of masked values (needs the channel key). */
export interface FormMatcher {
  readonly rolling: RollingHash;
  readonly hash: FormHasher;
}

export interface NetKnowledge {
  /** Email stand-ins issued in this tab, normalised. */
  readonly standIns: ReadonlySet<string>;
  /** Accepts stand-ins issued before this page load (e.g. a known format). */
  readonly isStandIn: (normalisedEmail: string) => boolean;
  /**
   * Forms of the values the user masked in this tab: the rolling values of
   * each form length (pre-check) and the keyed hashes (confirmation).
   */
  readonly rollingByLength: ReadonlyMap<number, ReadonlySet<number>>;
  readonly formHashes: ReadonlySet<string>;
  readonly matcher: FormMatcher | null;
}

/**
 * Tier 1, the user's text in first-party writes (escaping already undone):
 * any email that is not a stand-in means personal data is about to be sent.
 * Synchronous, so it covers every transport.
 */
export function violatesTier1(
  messageTexts: readonly string[],
  knowledge: NetKnowledge,
): boolean {
  return tier1Emails(messageTexts, knowledge, true) > 0;
}

/** Distinct emails in the texts that are not stand-ins. */
function tier1Emails(
  messageTexts: readonly string[],
  knowledge: NetKnowledge,
  firstOnly: boolean,
): number {
  const found = new Set<string>();
  for (const text of messageTexts) {
    for (const span of detectEmails(text)) {
      const email = normaliseValue('email', span.value);
      if (!knowledge.standIns.has(email) && !knowledge.isStandIn(email)) {
        found.add(email);
        if (firstOnly) return 1;
      }
    }
  }
  return found.size;
}

/**
 * The compact forms of a request text that tier 2 compares: as written and,
 * when they differ, with the site's escaping undone. An HTML reference in a
 * value (`07400&#x20;123456`) leaves letters and digits in the first
 * ("x20") and is gone from the second; checking both can only find more.
 */
export function compactForms(text: string): string[] {
  const raw = compactForm(text);
  if (!text.includes('&')) return [raw];
  const unescaped = compactForm(unescapeText(text).text);
  return unescaped === raw ? [raw] : [raw, unescaped];
}

/**
 * Tier 2, every request: a value the user has already masked in this tab
 * must never leave, whatever the destination or the way it is written. Each
 * text is reduced to its compact forms; every window as long as a masked
 * form whose rolling value matches is confirmed with the keyed hash.
 */
export function violatesTier2(
  texts: readonly string[],
  knowledge: NetKnowledge,
): boolean {
  const { matcher } = knowledge;
  if (!matcher || knowledge.formHashes.size === 0) return false;
  for (const text of texts) {
    for (const compact of compactForms(text)) {
      if (scanCompact(compact, knowledge, matcher, null)) return true;
    }
  }
  return false;
}

/**
 * The keyed hashes of every masked-value form in the texts (at most
 * MAX_BLOCKED_FORMS). Runs only once a request is blocked.
 */
function tier2Forms(
  texts: readonly string[],
  knowledge: NetKnowledge,
): string[] {
  const { matcher } = knowledge;
  const found = new Set<string>();
  if (!matcher) return [];
  for (const text of texts) {
    for (const compact of compactForms(text)) {
      if (scanCompact(compact, knowledge, matcher, found)) return [...found];
    }
  }
  return [...found];
}

/**
 * Looks for masked forms in one compact text. Without `collect`, stops at
 * the first; with it, gathers their hashes and stops when it is full.
 */
function scanCompact(
  compact: string,
  knowledge: NetKnowledge,
  matcher: FormMatcher,
  collect: Set<string> | null,
): boolean {
  for (const [length, values] of knowledge.rollingByLength) {
    const found = matcher.rolling.scan(compact, length, values, (start) => {
      const hash = matcher.hash(compact.slice(start, start + length));
      if (!knowledge.formHashes.has(hash)) return false;
      if (collect === null) return true;
      collect.add(hash);
      return collect.size >= MAX_BLOCKED_FORMS;
    });
    if (found) return true;
  }
  return false;
}

export interface CheckedTexts {
  /** All text the request carries: URL parts, body text and JSON strings. */
  readonly all: readonly string[];
  /** The user's text of a first-party write; null for other requests. */
  readonly user: readonly string[] | null;
}

/**
 * The synchronous checks: tier 1 on the user's text, tier 2 on everything.
 * The full detector (fetch only) runs after these, in the isolated world.
 */
export function decideRequest(
  texts: CheckedTexts,
  knowledge: NetKnowledge,
): NetVerdict {
  if (texts.user && violatesTier1(texts.user, knowledge)) {
    return {
      block: true,
      tier: 1,
      emails: tier1Emails(texts.user, knowledge, false),
    };
  }
  if (violatesTier2(texts.all, knowledge)) {
    return { block: true, tier: 2, forms: tier2Forms(texts.all, knowledge) };
  }
  return ALLOW;
}
