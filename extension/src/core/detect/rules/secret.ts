/**
 * Global SECRET rules.
 *
 * - Tokens: known vendor formats (checksum strength) and the generic
 *   high-entropy rule; within a context word's window the generic rule uses
 *   lower thresholds (CONTEXT_THRESHOLDS).
 * - PEM private key blocks.
 * - Credentials given by syntax: `Authorization: Basic <base64 user:pass>`,
 *   `Bearer <token>`, `curl -u user:pass`, and the password in a URL
 *   (`scheme://user:pass@host`). These forms are unambiguous, so they count
 *   as checksum strength (the URL password wins over the "email" the email
 *   rule sees in `pass@host`).
 * - Values assigned to secret-named keys (`api_key=…`, `"token": "…"`,
 *   `password: …`): a vendor format or a token passing the context
 *   thresholds (or 16+ hex digits) is confirmed; anything else is possible
 *   (low-entropy passwords are still passwords), except values that are
 *   clearly code or placeholders.
 *
 * Every pattern uses bounded, non-nested quantifiers, so scans stay linear.
 */
import type { Span } from '../text.ts';
import {
  CONTEXT_THRESHOLDS,
  isBasicCredentials,
  isHighEntropyToken,
  validateSecret,
} from '../validators/secret.ts';
import { INVALID, finding, type Rule, type Verdict } from './types.ts';

const SECRET_CONTEXT = {
  words: [
    'api key',
    'apikey',
    'token',
    'secret',
    'password',
    'passwd',
    'passphrase',
    'bearer',
    'authorization',
    'client secret',
    'access key',
    'private key',
    'credential',
    'credentials',
  ],
  before: 48,
  after: 24,
} as const;

const NO_CONTEXT = {
  context: null,
  contextRequired: false,
  negativeContext: [],
} as const;

/** Shortest token any vendor format can have (Slack: "xoxb-" + 10). */
const MIN_TOKEN = 15;
const MAX_TOKEN = 8192;

function isTokenChar(char: string): boolean {
  return /^[A-Za-z0-9+/_\-.~]$/u.test(char);
}

/**
 * Runs of token characters (base64, base64url, JWT dots), with "=" allowed
 * only as trailing padding. Trailing dots (end of a sentence) are not part of
 * the token.
 */
export function* findTokens(text: string): Generator<Span> {
  let at = 0;
  while (at < text.length) {
    if (!isTokenChar(text.charAt(at))) {
      at += 1;
      continue;
    }
    const start = at;
    while (at < text.length && isTokenChar(text.charAt(at))) at += 1;
    let end = at;
    let padding = 0;
    while (padding < 2 && text.charAt(end) === '=') {
      end += 1;
      padding += 1;
    }
    // "key=value": the "=" separates two tokens instead of padding one.
    if (padding > 0 && isTokenChar(text.charAt(end))) end = at;
    else at = end;
    let tokenEnd = end;
    while (tokenEnd > start && text.charAt(tokenEnd - 1) === '.') tokenEnd -= 1;
    if (tokenEnd - start >= MIN_TOKEN && tokenEnd - start <= MAX_TOKEN) {
      yield { start, end: tokenEnd };
    }
    if (at === start) at += 1;
  }
}

function tokenVerdict(rule: Rule, value: string, hasContext: boolean): Verdict {
  const result = validateSecret(value);
  if (result.valid) {
    return finding(
      rule,
      result.kind === 'high-entropy' ? 'structural' : 'checksum',
    );
  }
  if (hasContext && isHighEntropyToken(value, CONTEXT_THRESHOLDS)) {
    return finding(rule, 'structural');
  }
  return INVALID;
}

export const SECRET_TOKEN_RULE: Rule = {
  id: 'global.secret.token',
  type: 'SECRET',
  subtype: null,
  country: null,
  find: findTokens,
  validate: (value, env) =>
    tokenVerdict(SECRET_TOKEN_RULE, value, env.hasContext),
  context: SECRET_CONTEXT,
  contextRequired: false,
  negativeContext: [],
  confidence: { validated: 1, context: 0.9, none: 0.8 },
};

const PEM_BEGIN = '-----BEGIN ';
const PEM_END = '-----END ';
const PEM_DASHES = '-----';

/** BEGIN … END blocks; each END is searched for once, so the scan is linear. */
function* findPemBlocks(text: string): Generator<Span> {
  let from = 0;
  for (;;) {
    const start = text.indexOf(PEM_BEGIN, from);
    if (start === -1) return;
    const footer = text.indexOf(PEM_END, start + PEM_BEGIN.length);
    if (footer === -1) return;
    const close = text.indexOf(PEM_DASHES, footer + PEM_END.length);
    if (close === -1) return;
    const end = close + PEM_DASHES.length;
    yield { start, end };
    from = end;
  }
}

export const SECRET_PEM_RULE: Rule = {
  id: 'global.secret.pem',
  type: 'SECRET',
  subtype: null,
  country: null,
  find: findPemBlocks,
  validate: (value) =>
    validateSecret(value).valid
      ? finding(SECRET_PEM_RULE, 'checksum')
      : INVALID,
  ...NO_CONTEXT,
  confidence: { validated: 1, context: 1, none: 1 },
};

/** Spans of capture group 1 of every match (the pattern needs the "d" flag). */
function* groupSpans(text: string, pattern: RegExp): Generator<Span> {
  for (const match of text.matchAll(pattern)) {
    const span = match.indices?.[1];
    if (span !== undefined) yield { start: span[0], end: span[1] };
  }
}

const BASIC =
  /\bBasic[ \t]+([A-Za-z0-9+/]{8,8192}={0,2})(?![A-Za-z0-9+/=])/dgiu;

export const SECRET_BASIC_RULE: Rule = {
  id: 'global.secret.basic',
  type: 'SECRET',
  subtype: null,
  country: null,
  find: (text) => groupSpans(text, BASIC),
  validate: (value) =>
    isBasicCredentials(value)
      ? finding(SECRET_BASIC_RULE, 'checksum')
      : INVALID,
  ...NO_CONTEXT,
  confidence: { validated: 1, context: 1, none: 1 },
};

const BEARER =
  /\bBearer[ \t]+([A-Za-z0-9\-._~+/]{8,8192}={0,2})(?![A-Za-z0-9\-._~+/=])/dgiu;

/** At least two of: upper case, lower case, digits, symbols. Rules out prose ("Bearer authentication"). */
function looksLikeToken(value: string): boolean {
  const classes = [/[A-Z]/u, /[a-z]/u, /\d/u, /[^A-Za-z0-9]/u].filter(
    (pattern) => pattern.test(value),
  ).length;
  return classes >= 2;
}

export const SECRET_BEARER_RULE: Rule = {
  id: 'global.secret.bearer',
  type: 'SECRET',
  subtype: null,
  country: null,
  find: (text) => groupSpans(text, BEARER),
  validate(value) {
    // A JWT reads like member access (a.b.c), so known formats go first.
    if (validateSecret(value).valid)
      return finding(SECRET_BEARER_RULE, 'checksum');
    return looksLikeToken(value) && !isPlaceholder(value)
      ? finding(SECRET_BEARER_RULE, 'checksum')
      : INVALID;
  },
  ...NO_CONTEXT,
  confidence: { validated: 1, context: 1, none: 1 },
};

/** curl/wget `-u user:pass` or `--user user:pass`: the password. */
const USER_OPTION =
  /(?:^|\s)(?:-u|--user|--http-user)(?:[ \t]+|=)(['"]?)[^\s:'"]{1,128}:([^\s'"]{1,256})\1(?![^\s'"])/dgu;

/** `scheme://user:pass@host`: the password. */
const URL_USERINFO =
  /\b[A-Za-z][A-Za-z0-9+.-]{0,31}:\/\/[^\s:@/?#]{1,128}:([^\s@/?#]{1,256})@/dgu;

function* passwordSpans(text: string): Generator<Span> {
  for (const match of text.matchAll(USER_OPTION)) {
    const span = match.indices?.[2];
    if (span !== undefined) yield { start: span[0], end: span[1] };
  }
  yield* groupSpans(text, URL_USERINFO);
}

export const SECRET_USERINFO_RULE: Rule = {
  id: 'global.secret.userinfo',
  type: 'SECRET',
  subtype: null,
  country: null,
  find: (text) => [...passwordSpans(text)].sort((a, b) => a.start - b.start),
  validate: (value) =>
    isPlaceholder(value) ? INVALID : finding(SECRET_USERINFO_RULE, 'checksum'),
  ...NO_CONTEXT,
  confidence: { validated: 1, context: 1, none: 1 },
};

/**
 * Key names that hold secrets, as words of the key ("DB_PASSWORD",
 * "githubToken", "x-api-key", "client_secret"). "key" alone is too common
 * (YAML, maps), so it counts only after api/access/secret/private/...
 */
const SECRET_KEY_WORDS = new Set([
  'password',
  'passwd',
  'pwd',
  'pass',
  'passphrase',
  'secret',
  'token',
  'apikey',
  'auth',
  'authorization',
  'credential',
  'credentials',
  'bearer',
]);
const KEY_QUALIFIERS = new Set([
  'api',
  'access',
  'secret',
  'private',
  'signing',
  'encryption',
  'client',
  'master',
  'license',
]);

function keyWords(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/gu, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter((word) => word.length > 0);
}

export function isSecretKeyName(key: string): boolean {
  const words = keyWords(key);
  return words.some(
    (word, index) =>
      SECRET_KEY_WORDS.has(word) ||
      (word === 'key' &&
        index > 0 &&
        KEY_QUALIFIERS.has(words[index - 1] ?? '')),
  );
}

/** `key = value`, `key: value`, `"key": "value"`, `key => value`, `key := value`. */
const ASSIGNMENT =
  /(?<![A-Za-z0-9_$])(["'`]?)([A-Za-z_$][A-Za-z0-9_$.-]{0,63})\1[ \t]{0,3}(?:=>|:=|=|:)[ \t]{0,3}/gu;

const QUOTES = new Set(['"', "'", '`']);
const UNQUOTED_END = /[\s,;&)}\]]/u;
const MAX_VALUE = 4096;

interface AssignedValue {
  /** The value, or null if there is none (empty, unterminated, too long). */
  value: Span | null;
  /** Where reading stopped; scanning resumes there, keeping it linear. */
  scanned: number;
}

/** The value after an assignment operator ending at `from`. */
function assignedValue(text: string, from: number): AssignedValue {
  const quote = text.charAt(from);
  if (QUOTES.has(quote)) {
    const start = from + 1;
    let end = start;
    while (
      end < text.length &&
      end - start <= MAX_VALUE &&
      text.charAt(end) !== quote &&
      text.charAt(end) !== '\n'
    ) {
      end += 1;
    }
    const closed = text.charAt(end) === quote;
    return { value: closed ? { start, end } : null, scanned: end };
  }
  let end = from;
  // Brackets opened in the value (a call such as getPassword()) are part of it.
  let depth = 0;
  while (end < text.length && end - from <= MAX_VALUE) {
    const char = text.charAt(end);
    if (char === '(' || char === '[') depth += 1;
    else if ((char === ')' || char === ']') && depth > 0) depth -= 1;
    else if (depth === 0 && (UNQUOTED_END.test(char) || QUOTES.has(char)))
      break;
    else if (depth > 0 && char === '\n') break;
    end += 1;
  }
  const scanned = end;
  if (end - from > MAX_VALUE) return { value: null, scanned };
  // A full stop or colon at the end belongs to the sentence.
  while (end > from && '.:'.includes(text.charAt(end - 1))) end -= 1;
  return { value: end > from ? { start: from, end } : null, scanned };
}

function* findAssignedSecrets(text: string): Generator<Span> {
  // A copy per scan: lastIndex is moved past each value read.
  const assignments = new RegExp(ASSIGNMENT.source, ASSIGNMENT.flags);
  for (
    let match = assignments.exec(text);
    match !== null;
    match = assignments.exec(text)
  ) {
    const key = match[2] ?? '';
    if (!isSecretKeyName(key)) continue;
    const { value, scanned } = assignedValue(
      text,
      match.index + match[0].length,
    );
    assignments.lastIndex = Math.max(assignments.lastIndex, scanned);
    if (value === null) continue;
    // "Authorization: Bearer …" and "Basic …" have their own rules.
    if (
      /^(?:Bearer|Basic|Token|Digest)$/iu.test(
        text.slice(value.start, value.end),
      )
    ) {
      continue;
    }
    if (
      /^["'`]?(?:Bearer|Basic)\s/iu.test(text.slice(value.start, value.end))
    ) {
      continue;
    }
    yield value;
  }
}

const CODE_LITERALS = new Set([
  'string',
  'number',
  'boolean',
  'bool',
  'str',
  'int',
  'null',
  'undefined',
  'true',
  'false',
  'none',
  'nil',
]);

const PLACEHOLDERS: readonly RegExp[] = [
  // One character repeated: ***, xxxx, ....
  /^(.)\1*$/u,
  // <your key>, {{token}}, ${API_KEY}, {token}, [REDACTED], %API_KEY%, $API_KEY
  /^<[^<>]*>$/u,
  /^\{\{[^{}]*\}\}$/u,
  /^\$\{[^{}]*\}$/u,
  /^\{[^{}]*\}$/u,
  /^\[[^[\]]*\]$/u,
  /^%[A-Za-z0-9_]+%$/u,
  /^\$[A-Za-z_][A-Za-z0-9_]*$/u,
  // YOUR_API_KEY, your-token-here, my_secret_key
  /^(?:your|my|the|enter|insert)[\s_-]?[A-Za-z0-9_-]{0,40}?(?:key|token|secret|password|pass|pwd)(?:[\s_-]?here)?$/iu,
];

const CODE: readonly RegExp[] = [
  // Member access: req.body.password, config.pwd, process.env.TOKEN, self.secret
  /^[A-Za-z_$][\w$]*(?:\??\.[A-Za-z_$][\w$]*|\[[^\]]{1,64}\]){1,16}$/u,
  // Function calls: getPassword(), os.getenv("TOKEN")
  /^[A-Za-z_$][\w$.]{0,127}\(.{0,256}\)$/u,
];

/** True for placeholders such as "***", "<your key>" or "${API_KEY}". */
export function isPlaceholder(value: string): boolean {
  const trimmed = value.trim();
  return (
    trimmed.length === 0 ||
    PLACEHOLDERS.some((pattern) => pattern.test(trimmed))
  );
}

/**
 * True for values that are code or placeholders, not secrets: type names and
 * literals, member access and function calls. Only assigned values can be
 * code; after "Bearer" or in a URL a dotted value is a token.
 */
export function isPlaceholderOrCode(value: string): boolean {
  const trimmed = value.trim();
  if (isPlaceholder(trimmed)) return true;
  if (CODE_LITERALS.has(trimmed.toLowerCase())) return true;
  return CODE.some((pattern) => pattern.test(trimmed));
}

const HEX_KEY = /^[0-9a-fA-F]{16,}$/u;

export const SECRET_ASSIGNMENT_RULE: Rule = {
  id: 'global.secret.assignment',
  type: 'SECRET',
  subtype: null,
  country: null,
  find: findAssignedSecrets,
  validate(value) {
    // Known formats first: a JWT reads like member access (a.b.c).
    const token = tokenVerdict(SECRET_ASSIGNMENT_RULE, value, true);
    if (token.valid) return token;
    if (isPlaceholderOrCode(value)) return INVALID;
    if (HEX_KEY.test(value))
      return finding(SECRET_ASSIGNMENT_RULE, 'structural');
    return finding(SECRET_ASSIGNMENT_RULE, 'none', { possible: true });
  },
  ...NO_CONTEXT,
  confidence: { validated: 1, context: 0.9, none: 0.5 },
};

export const SECRET_RULES: readonly Rule[] = [
  SECRET_PEM_RULE,
  SECRET_BASIC_RULE,
  SECRET_BEARER_RULE,
  SECRET_USERINFO_RULE,
  SECRET_ASSIGNMENT_RULE,
  SECRET_TOKEN_RULE,
];
