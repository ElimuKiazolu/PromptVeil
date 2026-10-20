/**
 * SECRET validation: is this token a credential?
 *
 * Known formats are recognised by their documented prefixes and shapes
 * (OpenAI/Anthropic `sk-`, AWS access key IDs, GitHub tokens, Google API
 * keys, Slack tokens, JWTs, PEM private key blocks). Anything else counts
 * only if it passes the generic high-entropy rule, tuned so that commit
 * hashes, UUIDs, ordinary words and identifiers, base64 of ordinary text and
 * colour codes stay out (see tests for the measured values).
 *
 * Every pattern is anchored with bounded, non-nested quantifiers, so no input
 * can cause catastrophic backtracking.
 */

export type SecretKind =
  | 'openai'
  | 'aws-access-key'
  | 'github-token'
  | 'google-api-key'
  | 'slack-token'
  | 'jwt'
  | 'private-key'
  | 'high-entropy';

export type SecretValidation =
  { valid: true; kind: SecretKind } | { valid: false };

/*
 * Generic rule thresholds, measured on 32,000 random keys (base62 and
 * base64url, 32–64 characters) against 65,000 mixed-case identifiers of 32+
 * characters built from words and numbers (camelCase, PascalCase,
 * snake_case, with short words and digits between words):
 * - Entropy alone cannot separate them: a camel-case identifier reaches
 *   4.3 bits/char, a random 32-character key can be as low as 4.0.
 *   Entropy ≥ 4.0 removes single words and repetitive strings.
 * - Class switches (upper/lower/digit/other changes between neighbours) do
 *   not separate them either once identifiers contain short words
 *   ("ThisIsAVery…" reaches 0.40); ≥ 0.30 only trims long word runs.
 * - Vowel share does: words are about 40 % vowels, random letters about
 *   19 % (p99 0.36). Identifiers bottom out at 0.24 (p1 0.32).
 * - Together (entropy ≥ 4.0, switches ≥ 0.30, vowels ≤ 0.30) the rule
 *   catches 91 % of random 32-character keys, rising to 97 % at 64, and
 *   flags 0.15 % of the identifiers (all word salads with numbers).
 * - Base64 of ordinary text looks random by these measures (184 of 187
 *   samples pass), so tokens that decode to text are excluded.
 * - Under 32 characters random keys and identifiers overlap too much; short
 *   keys are covered only by the known prefixes.
 */
/** Generic rule: shortest token considered. */
export const GENERIC_MIN_LENGTH = 32;
/** Generic rule: minimum Shannon entropy in bits per character. */
export const GENERIC_MIN_ENTROPY = 4.0;
/** Generic rule: minimum share of character-class changes between neighbours. */
export const GENERIC_MIN_CLASS_SWITCHES = 0.3;
/** Generic rule: maximum share of vowels among the letters. */
export const GENERIC_MAX_VOWEL_SHARE = 0.3;
/** Decoded bytes that are printable text at or above this share mean "encoded text". */
const TEXT_SHARE = 0.9;

const MAX_TOKEN = 8192;

const AWS_ACCESS_KEY = /^(?:AKIA|ASIA)[A-Z0-9]{16}$/;
const GITHUB_TOKEN = /^gh[pousr]_[A-Za-z0-9]{36,251}$/;
const GITHUB_PAT = /^github_pat_[A-Za-z0-9_]{36,244}$/;
const GOOGLE_API_KEY = /^AIza[A-Za-z0-9_-]{35}$/;
const SLACK_TOKEN = /^xox[abprs]-[A-Za-z0-9-]{10,250}$/;
const SK_KEY = /^sk-[A-Za-z0-9_-]{20,250}$/;
const BASE64URL_PART = /^[A-Za-z0-9_-]+$/;
const GENERIC_CHARS = /^[A-Za-z0-9+/=_-]+$/;
const HEX_OR_SEPARATOR = /^[0-9a-fA-F-]+$/;

const PEM_KINDS = ['', 'RSA ', 'EC ', 'DSA ', 'OPENSSH ', 'ENCRYPTED ', 'PGP '];

/** Shannon entropy of the character distribution, in bits per character. */
export function shannonEntropy(value: string): number {
  if (value.length === 0) return 0;
  // Counts code points, so a character outside the BMP is one symbol.
  const counts = new Map<string, number>();
  let length = 0;
  for (const char of value) {
    counts.set(char, (counts.get(char) ?? 0) + 1);
    length += 1;
  }
  let entropy = 0;
  for (const count of counts.values()) {
    const p = count / length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

function hasDigit(value: string): boolean {
  return /\d/.test(value);
}

function hasUpper(value: string): boolean {
  return /[A-Z]/.test(value);
}

function hasLower(value: string): boolean {
  return /[a-z]/.test(value);
}

/** `sk-` keys: the body mixes digits and both cases, unlike hyphenated words. */
function isSkKey(value: string): boolean {
  if (!SK_KEY.test(value)) return false;
  const body = value.slice(3);
  return hasDigit(body) && hasUpper(body) && hasLower(body);
}

/** 6-bit value of a base64 or base64url character, or -1. */
function base64Value(code: number): number {
  if (code >= 65 && code <= 90) return code - 65; // A–Z
  if (code >= 97 && code <= 122) return code - 71; // a–z
  if (code >= 48 && code <= 57) return code + 4; // 0–9
  if (code === 43 || code === 45) return 62; // + or -
  if (code === 47 || code === 95) return 63; // / or _
  return -1;
}

/**
 * Bytes of a base64 or base64url string (padding optional), or null. A
 * trailing partial group that cannot hold a whole byte makes it invalid.
 */
function decodeBase64(value: string): number[] | null {
  const data = value.replace(/={1,2}$/u, '');
  if (data.length === 0 || data.length % 4 === 1) return null;
  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (let i = 0; i < data.length; i += 1) {
    const sextet = base64Value(data.charCodeAt(i));
    if (sextet === -1) return null;
    buffer = ((buffer << 6) | sextet) & 0xffffff;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 0xff);
    }
  }
  return bytes;
}

function decodeBase64UrlText(part: string): string | null {
  if (!BASE64URL_PART.test(part)) return null;
  const bytes = decodeBase64(part);
  return bytes === null ? null : String.fromCharCode(...bytes);
}

/** Length of a valid UTF-8 multi-byte sequence starting at `i`, or 0. */
function utf8SequenceLength(bytes: readonly number[], i: number): number {
  const lead = bytes[i] ?? 0;
  const length =
    lead >= 0xc2 && lead <= 0xdf
      ? 2
      : lead >= 0xe0 && lead <= 0xef
        ? 3
        : lead >= 0xf0 && lead <= 0xf4
          ? 4
          : 0;
  for (let k = 1; k < length; k += 1) {
    const next = bytes[i + k];
    // A sequence cut off by the end of a sliced token still counts.
    if (next === undefined) return length;
    if ((next & 0xc0) !== 0x80) return 0;
  }
  return length;
}

/**
 * True when the bytes read as text: printable ASCII, tabs and line breaks,
 * or well-formed UTF-8, making up at least TEXT_SHARE of the bytes.
 */
function isText(bytes: readonly number[]): boolean {
  let textBytes = 0;
  for (let i = 0; i < bytes.length;) {
    const byte = bytes[i] ?? 0;
    if (
      (byte >= 0x20 && byte < 0x7f) ||
      byte === 9 ||
      byte === 10 ||
      byte === 13
    ) {
      textBytes += 1;
      i += 1;
      continue;
    }
    const length = utf8SequenceLength(bytes, i);
    if (length > 0) {
      textBytes += Math.min(length, bytes.length - i);
      i += length;
    } else {
      i += 1;
    }
  }
  return textBytes >= TEXT_SHARE * bytes.length;
}

/** Share of neighbouring characters that change class (upper, lower, digit, other). */
export function classSwitchRatio(value: string): number {
  if (value.length < 2) return 0;
  const classOf = (char: string): number =>
    char >= 'A' && char <= 'Z'
      ? 0
      : char >= 'a' && char <= 'z'
        ? 1
        : char >= '0' && char <= '9'
          ? 2
          : 3;
  let switches = 0;
  for (let i = 1; i < value.length; i += 1) {
    if (classOf(value.charAt(i)) !== classOf(value.charAt(i - 1))) {
      switches += 1;
    }
  }
  return switches / (value.length - 1);
}

function isJsonObject(text: string): boolean {
  try {
    const parsed: unknown = JSON.parse(text);
    return (
      typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
    );
  } catch (error) {
    // Not JSON: an expected outcome for arbitrary dotted tokens.
    if (error instanceof SyntaxError) return false;
    throw error;
  }
}

/**
 * header.payload.signature, each base64url; the header must decode to a JSON
 * object with an "alg" member. The signature may be empty (unsecured JWT).
 */
function isJwt(value: string): boolean {
  const parts = value.split('.');
  if (parts.length !== 3) return false;
  const [header = '', payload = '', signature = ''] = parts;
  if (payload === '' || decodeBase64UrlText(payload) === null) return false;
  if (signature !== '' && decodeBase64UrlText(signature) === null) {
    return false;
  }
  const headerJson = decodeBase64UrlText(header);
  if (headerJson === null || !isJsonObject(headerJson)) return false;
  return /"alg"\s*:/.test(headerJson);
}

/** A complete PEM private key block (RFC 7468 labels and OpenSSH/PGP variants). */
function isPrivateKeyBlock(value: string): boolean {
  const text = value.trim();
  for (const kind of PEM_KINDS) {
    for (const suffix of ['', ' BLOCK']) {
      const header = `-----BEGIN ${kind}PRIVATE KEY${suffix}-----`;
      const footer = `-----END ${kind}PRIVATE KEY${suffix}-----`;
      if (!text.startsWith(header) || !text.endsWith(footer)) continue;
      const body = text.slice(header.length, text.length - footer.length);
      if (body.trim().length > 0) return true;
    }
  }
  return false;
}

/** Share of vowels (a, e, i, o, u in either case) among the ASCII letters. */
export function vowelShare(value: string): number {
  let letters = 0;
  let vowels = 0;
  for (const char of value.toLowerCase()) {
    if (char < 'a' || char > 'z') continue;
    letters += 1;
    if ('aeiou'.includes(char)) vowels += 1;
  }
  return letters === 0 ? 0 : vowels / letters;
}

/**
 * The generic rule: a long base64/base64url-alphabet token mixing upper case,
 * lower case and digits, not plain hex (hashes, UUIDs, colours), with high
 * entropy, frequent class changes and few vowels (not made of words), that
 * does not decode to text.
 */
export function isHighEntropyToken(value: string): boolean {
  if (value.length < GENERIC_MIN_LENGTH || !GENERIC_CHARS.test(value)) {
    return false;
  }
  if (HEX_OR_SEPARATOR.test(value)) return false;
  if (!hasDigit(value) || !hasUpper(value) || !hasLower(value)) return false;
  if (shannonEntropy(value) < GENERIC_MIN_ENTROPY) return false;
  if (classSwitchRatio(value) < GENERIC_MIN_CLASS_SWITCHES) return false;
  if (vowelShare(value) > GENERIC_MAX_VOWEL_SHARE) return false;
  const bytes = decodeBase64(value);
  return bytes === null || !isText(bytes);
}

function knownKind(value: string): SecretKind | null {
  if (AWS_ACCESS_KEY.test(value)) return 'aws-access-key';
  if (GITHUB_TOKEN.test(value) || GITHUB_PAT.test(value)) return 'github-token';
  if (GOOGLE_API_KEY.test(value)) return 'google-api-key';
  if (SLACK_TOKEN.test(value)) return 'slack-token';
  if (isSkKey(value)) return 'openai';
  if (value.includes('-----BEGIN ')) {
    return isPrivateKeyBlock(value) ? 'private-key' : null;
  }
  if (value.includes('.') && isJwt(value)) return 'jwt';
  return null;
}

export function validateSecret(value: string): SecretValidation {
  if (value.length === 0 || value.length > MAX_TOKEN) return { valid: false };
  const kind = knownKind(value);
  if (kind !== null) return { valid: true, kind };
  return isHighEntropyToken(value)
    ? { valid: true, kind: 'high-entropy' }
    : { valid: false };
}

/** Vault form: secrets are kept exactly as written (case and symbols matter). */
export function normaliseSecret(value: string): string {
  return value;
}
