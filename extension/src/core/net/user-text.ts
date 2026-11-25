/**
 * Which strings of a request body a user may have typed, for requests the
 * site adapter has no exact extractor for (see SiteNetRules). The full
 * detector runs on what this selects, so it must include free text and
 * leave out the machine fields a site sends with every request (IDs,
 * tokens, proofs, timestamps), where digit runs and random strings would
 * read as phone numbers or secrets and block the site's own traffic.
 *
 * A string value is free text when its key does not name an ID or token
 * and either
 * - its key names a text field (text, content, title, name, email, …), or
 * - it contains whitespace, markdown punctuation or "@", and is not shaped
 *   like an ID or token.
 * Object keys themselves are never free text. Every string, keys included,
 * is still checked by tier 2 (values already masked in this tab).
 */

const MAX_DEPTH = 64;

/**
 * Keys that hold identifiers or credentials the site generates: `id`,
 * `*_id`, `*Id`, `*_ids`, tokens, proofs, nonces, hashes, signatures.
 */
const ID_KEY =
  /^(?:id|ids|uuid|guid|token|tokens|proof|nonce|hash|signature|sig|etag|cursor)$|[_-](?:id|ids|uuid|guid|token|tokens|proof|nonce|hash|signature|sig|etag|cursor)$|[a-z0-9](?:Id|Ids|Uuid|Guid|Token|Tokens|Proof|Nonce|Hash|Signature|Etag|Cursor)$/;

/** Keys that hold text a person wrote or entered. */
const TEXT_KEY =
  /^(?:text|texts|content|contents|title|name|subject|recipient|recipients|to|cc|bcc|email|emails|phone|address|query|prompt|message|instruction|instructions|description|about|bio|note|notes|body|comment|caption|summary|parts)$|[_-](?:text|content|title|name|subject|recipient|email|phone|address|query|prompt|message|instructions?|description|note|notes|body|comment|caption|summary)$|[a-z0-9](?:Text|Content|Title|Name|Subject|Recipient|Email|Phone|Address|Query|Prompt|Message|Instructions?|Description|Note|Notes|Body|Comment|Caption|Summary)$/;

const WHITESPACE = /\s/u;
/** Markdown punctuation that IDs and tokens do not use. */
const MARKDOWN = /[*`#>[\]|~\\]/u;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/**
 * Long runs of URL-safe or base64 characters with no word structure. "~" is
 * an unreserved URL character that tokens carry too: ChatGPT's sentinel
 * proof values end in "~S" (a base64 run with a "~" suffix read as markdown
 * and scanned as free text, where the generic secret rule confirmed it).
 */
const TOKEN = /^[A-Za-z0-9+/=_.:~-]{16,}$/;
const HAS_DIGIT = /\d/;
const HAS_LETTER = /[A-Za-z]/;

export function isIdKey(key: string): boolean {
  return ID_KEY.test(key);
}

export function isTextKey(key: string): boolean {
  return TEXT_KEY.test(key);
}

/**
 * True for a value that looks generated: a UUID, or a long run of token
 * characters mixing letters and digits (no spaces, no "@").
 */
export function isTokenShaped(value: string): boolean {
  if (UUID.test(value)) return true;
  return TOKEN.test(value) && HAS_DIGIT.test(value) && HAS_LETTER.test(value);
}

/** True when a string value under `key` (null: no key) is free text. */
export function isFreeText(key: string | null, value: string): boolean {
  if (value.length === 0) return false;
  if (key !== null && isIdKey(key)) return false;
  if (key !== null && isTextKey(key)) return true;
  if (isTokenShaped(value)) return false;
  return WHITESPACE.test(value) || MARKDOWN.test(value) || value.includes('@');
}

/**
 * The free-text strings in a parsed JSON value. Array items inherit the key
 * of their array.
 */
export function freeTextStrings(value: unknown): string[] {
  const out: string[] = [];
  const stack: { value: unknown; key: string | null; depth: number }[] = [
    { value, key: null, depth: 0 },
  ];
  while (stack.length > 0) {
    const item = stack.pop();
    if (!item) break;
    const current = item.value;
    if (typeof current === 'string') {
      if (isFreeText(item.key, current)) out.push(current);
    } else if (Array.isArray(current)) {
      if (item.depth >= MAX_DEPTH) continue;
      // An ID key's array (e.g. message_ids) holds IDs too.
      if (item.key !== null && isIdKey(item.key)) continue;
      for (let i = current.length - 1; i >= 0; i -= 1) {
        stack.push({ value: current[i], key: item.key, depth: item.depth + 1 });
      }
    } else if (typeof current === 'object' && current !== null) {
      if (item.depth >= MAX_DEPTH) continue;
      const entries = Object.entries(current);
      for (let i = entries.length - 1; i >= 0; i -= 1) {
        const entry = entries[i];
        if (entry === undefined) continue;
        stack.push({ value: entry[1], key: entry[0], depth: item.depth + 1 });
      }
    }
  }
  return out;
}

/** Key names safe to print in a dev log (identifier-shaped, short). */
const LOGGABLE_KEY = /^[A-Za-z_][A-Za-z0-9_-]{0,39}$/;
const MAX_LOGGED_KEYS = 40;

/**
 * Key names of a parsed body for the dev log: the top-level keys, plus the
 * keys under each of `nested` (dot paths such as "writing_block.metadata").
 * A key that is not identifier-shaped (it could be data) prints as "?".
 */
export function keyNames(
  value: unknown,
  nested: readonly string[] = [],
): string[] {
  const out: string[] = [];
  const add = (prefix: string, object: unknown): void => {
    if (typeof object !== 'object' || object === null) return;
    if (Array.isArray(object)) return;
    for (const key of Object.keys(object)) {
      if (out.length >= MAX_LOGGED_KEYS) return;
      out.push(prefix + (LOGGABLE_KEY.test(key) ? key : '?'));
    }
  };
  add('', value);
  for (const path of nested) {
    let current: unknown = value;
    for (const part of path.split('.')) {
      current =
        typeof current === 'object' && current !== null
          ? (current as Record<string, unknown>)[part]
          : undefined;
    }
    add(`${path}.`, current);
  }
  return out;
}
