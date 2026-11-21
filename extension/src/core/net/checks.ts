import { detectEmails } from '../detect/rules/email.ts';
import { compactForm } from './compact.ts';
import { normaliseValue, type FormHasher } from './hash.ts';
import type { RollingHash } from './rolling.ts';
import { unescapeText } from './unescape.ts';

export type NetTier = 1 | 2;

export type NetVerdict = { block: false } | { block: true; tier: NetTier };

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
  for (const text of messageTexts) {
    for (const span of detectEmails(text)) {
      const email = normaliseValue('email', span.value);
      if (!knowledge.standIns.has(email) && !knowledge.isStandIn(email)) {
        return true;
      }
    }
  }
  return false;
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
      if (violatesCompact(compact, knowledge, matcher)) return true;
    }
  }
  return false;
}

function violatesCompact(
  compact: string,
  knowledge: NetKnowledge,
  matcher: FormMatcher,
): boolean {
  for (const [length, values] of knowledge.rollingByLength) {
    const found = matcher.rolling.scan(compact, length, values, (start) =>
      knowledge.formHashes.has(
        matcher.hash(compact.slice(start, start + length)),
      ),
    );
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
    return { block: true, tier: 1 };
  }
  if (violatesTier2(texts.all, knowledge)) return { block: true, tier: 2 };
  return ALLOW;
}
