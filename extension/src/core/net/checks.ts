import { detectEmails } from '../detect/rules/email.ts';
import { normaliseValue, type ValueHasher } from './hash.ts';

export type NetTier = 1 | 2;

export type NetVerdict = { block: false } | { block: true; tier: NetTier };

const ALLOW: NetVerdict = { block: false };

/** Nesting deeper than this is not followed; such bodies are not normal. */
const MAX_JSON_DEPTH = 64;

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

export interface NetKnowledge {
  /** Stand-ins issued in this tab, normalised. */
  readonly standIns: ReadonlySet<string>;
  /** Accepts stand-ins issued before this page load (e.g. a known format). */
  readonly isStandIn: (normalisedEmail: string) => boolean;
  /** Keyed hashes of real values the user has masked in this tab. */
  readonly realValueHashes: ReadonlySet<string>;
  readonly hash: ValueHasher | null;
}

/**
 * Tier 1, message endpoints: any email in the message text that is not a
 * stand-in means personal data is about to be sent.
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
 * Tier 2, every request: a value the user has already masked in this tab
 * must never leave, whatever the destination.
 */
export function violatesTier2(
  texts: readonly string[],
  knowledge: NetKnowledge,
): boolean {
  const { hash } = knowledge;
  if (!hash || knowledge.realValueHashes.size === 0) return false;
  for (const text of texts) {
    for (const span of detectEmails(text)) {
      if (knowledge.realValueHashes.has(hash('email', span.value))) {
        return true;
      }
    }
  }
  return false;
}

export interface RequestTexts {
  /** All text the request carries: URL parts, body text and JSON strings. */
  readonly all: readonly string[];
  /** Message text for tier 1; null when this is not a message endpoint. */
  readonly message: readonly string[] | null;
}

export function decideRequest(
  texts: RequestTexts,
  knowledge: NetKnowledge,
): NetVerdict {
  if (texts.message && violatesTier1(texts.message, knowledge)) {
    return { block: true, tier: 1 };
  }
  if (violatesTier2(texts.all, knowledge)) return { block: true, tier: 2 };
  return ALLOW;
}
