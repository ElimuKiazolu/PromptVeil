/**
 * SECRET stand-ins (TR-S2): the same prefix, the same length, random
 * characters of the same alphabet, and the same kind of secret.
 *
 * - Tokens: a vendor prefix ("ghp_", "AKIA", "sk-", "xoxb-", ...) is kept;
 *   every other letter or digit is replaced by a random one of its class
 *   (upper case, lower case, digit), letters staying within a–f / A–F when
 *   the token is hexadecimal; punctuation stays in place. The result must be
 *   recognised as the same kind (vendor format, or the generic high-entropy
 *   rule) when the real value was.
 * - AWS access key IDs: the first attempt is AWS's documented example key ID,
 *   AKIAIOSFODNN7EXAMPLE (AWS IAM documentation, "Managing access keys").
 * - JWTs: a header with the real algorithm ({"alg":…,"typ":"JWT"}), a
 *   random {"sub":…} payload of about the same length, a random signature
 *   of the same length (empty stays empty).
 * - HTTP Basic credentials: random user and password of the same lengths
 *   and character classes, encoded as before.
 * - PEM private keys: header and footer lines kept, the body scrambled.
 */
import {
  decodeBase64,
  isBasicCredentials,
  validateSecret,
  type SecretKind,
} from '../detect/validators/secret.ts';
import { DIGITS, LOWER, UPPER, type Rng } from './rng.ts';
import type { Generator } from './types.ts';

/** Longest first, so "sk-proj-" wins over "sk-". */
const VENDOR_PREFIXES = [
  'github_pat_',
  'sk-proj-',
  'sk_live_',
  'sk_test_',
  'pk_live_',
  'pk_test_',
  'rk_live_',
  'rk_test_',
  'sk-ant-',
  'xoxa-',
  'xoxb-',
  'xoxp-',
  'xoxr-',
  'xoxs-',
  'ghp_',
  'gho_',
  'ghu_',
  'ghs_',
  'ghr_',
  'AKIA',
  'ASIA',
  'AIza',
  'sk-',
];

export const AWS_EXAMPLE_ACCESS_KEY_ID = 'AKIAIOSFODNN7EXAMPLE';

const RANDOM_DRAWS = 32;
const BASE64 = `${UPPER}${LOWER}${DIGITS}+/`;
const BASE64URL = `${UPPER}${LOWER}${DIGITS}-_`;

interface Alphabets {
  lower: string;
  upper: string;
}

/** Hexadecimal letters stay hexadecimal. */
function alphabetsOf(text: string): Alphabets {
  return {
    lower: /^[^g-z]*$/u.test(text) && /[a-f]/u.test(text) ? 'abcdef' : LOWER,
    upper: /^[^G-Z]*$/u.test(text) && /[A-F]/u.test(text) ? 'ABCDEF' : UPPER,
  };
}

/** Each ASCII letter or digit replaced by a random one of its class. */
function scramble(text: string, rng: Rng, alphabets: Alphabets): string {
  let out = '';
  for (const char of text) {
    if (char >= 'a' && char <= 'z') out += rng.char(alphabets.lower);
    else if (char >= 'A' && char <= 'Z') out += rng.char(alphabets.upper);
    else if (char >= '0' && char <= '9') out += rng.char(DIGITS);
    else out += char;
  }
  return out;
}

function encodeBase64(bytes: Uint8Array, alphabet: string, pad: boolean) {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] ?? 0;
    const b = bytes[i + 1] ?? 0;
    const c = bytes[i + 2] ?? 0;
    const chunk = (a << 16) | (b << 8) | c;
    const length = Math.min(3, bytes.length - i) + 1;
    for (let k = 0; k < 4; k += 1) {
      if (k < length) out += alphabet.charAt((chunk >> (18 - 6 * k)) & 63);
      else if (pad) out += '=';
    }
  }
  return out;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function decodeText(base64: string): string | null {
  const bytes = decodeBase64(base64);
  return bytes === null ? null : decoder.decode(new Uint8Array(bytes));
}

function jwtStandIn(value: string, rng: Rng): string | null {
  const [header = '', payload = '', signature = ''] = value.split('.');
  const headerText = decodeText(header);
  if (headerText === null) return null;
  const parsed: unknown = JSON.parse(headerText);
  const alg =
    typeof parsed === 'object' &&
    parsed !== null &&
    'alg' in parsed &&
    typeof parsed.alg === 'string'
      ? parsed.alg
      : 'HS256';
  const newHeader = encodeBase64(
    encoder.encode(JSON.stringify({ alg, typ: 'JWT' })),
    BASE64URL,
    false,
  );
  // {"sub":"…"} is 10 characters around the identifier.
  const idLength = Math.max(4, Math.floor((payload.length * 3) / 4) - 10);
  const newPayload = encodeBase64(
    encoder.encode(
      JSON.stringify({ sub: rng.chars(LOWER + DIGITS, idLength) }),
    ),
    BASE64URL,
    false,
  );
  const newSignature = signature.replace(/[A-Za-z0-9_-]/gu, () =>
    rng.char(BASE64URL),
  );
  return `${newHeader}.${newPayload}.${newSignature}`;
}

function basicStandIn(value: string, rng: Rng): string | null {
  const text = decodeText(value);
  if (text === null) return null;
  const colon = text.indexOf(':');
  const alphabets = { lower: LOWER, upper: UPPER };
  const user = scramble(text.slice(0, colon), rng, alphabets);
  const password = scramble(text.slice(colon + 1), rng, alphabets);
  return encodeBase64(
    encoder.encode(`${user}:${password}`),
    BASE64,
    value.endsWith('='),
  );
}

const PEM =
  /^(\s*-----BEGIN [A-Z ]+-----)([\s\S]*)(-----END [A-Z ]+-----\s*)$/u;

function pemStandIn(value: string, rng: Rng): string | null {
  const parts = PEM.exec(value);
  if (parts === null) return null;
  const [, header = '', body = '', footer = ''] = parts;
  return header + scramble(body, rng, { lower: LOWER, upper: UPPER }) + footer;
}

function tokenStandIn(value: string, rng: Rng): string {
  const prefix = VENDOR_PREFIXES.find((entry) => value.startsWith(entry)) ?? '';
  const body = value.slice(prefix.length);
  return prefix + scramble(body, rng, alphabetsOf(body));
}

function kindOf(value: string): SecretKind | 'basic' | null {
  const result = validateSecret(value);
  if (result.valid) return result.kind;
  return isBasicCredentials(value) ? 'basic' : null;
}

/**
 * True when a stand-in is the same kind of secret as the real value (the
 * format check for SECRET): same length for tokens, recognised as the same
 * kind where the real value was.
 */
export function isWellFormedSecretStandIn(
  standIn: string,
  real: string,
): boolean {
  const kind = kindOf(real);
  if (kindOf(standIn) !== kind) return false;
  return kind === 'jwt' || kind === 'basic' || standIn.length === real.length;
}

export const secretStandIn: Generator = ({
  request,
  rng,
  attempt,
  reservedAllowed,
}) => {
  const real = request.value;
  const kind = kindOf(real);
  if (
    kind === 'aws-access-key' &&
    reservedAllowed &&
    attempt === 0 &&
    real.startsWith('AKIA') &&
    real !== AWS_EXAMPLE_ACCESS_KEY_ID
  ) {
    return { value: AWS_EXAMPLE_ACCESS_KEY_ID, reserved: true };
  }
  for (let draw = 0; draw < RANDOM_DRAWS; draw += 1) {
    const candidate =
      kind === 'jwt'
        ? jwtStandIn(real, rng)
        : kind === 'basic'
          ? basicStandIn(real, rng)
          : kind === 'private-key'
            ? pemStandIn(real, rng)
            : tokenStandIn(real, rng);
    if (
      candidate !== null &&
      candidate !== real &&
      isWellFormedSecretStandIn(candidate, real)
    ) {
      return { value: candidate, reserved: false };
    }
  }
  return null;
};
