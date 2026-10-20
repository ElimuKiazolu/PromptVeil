/**
 * EMAIL validation and normalisation.
 *
 * Accepted: a dot-atom local part of letters, digits and `._%+'-` (so
 * plus-addressing and Unicode letters work) and a domain of two or more
 * labels ending in a real-looking TLD. Rejected by rule: quoted local parts
 * (`"john doe"@example.com`) and address literals (`user@[192.0.2.1]`). Both
 * are legal in RFC 5321 but almost never used, and accepting quotes would
 * make the boundaries of an address in free text ambiguous.
 *
 * No pattern here can backtrack: labels are bounded to 63 characters and
 * everything else is a per-character check.
 */

export const MAX_EMAIL_LOCAL = 64;
export const MAX_EMAIL_DOMAIN = 253;
export const MAX_EMAIL_ADDRESS = 254;
const MAX_LABEL = 63;

const LOCAL_CHAR = /[\p{L}\p{N}._%+'-]/u;
const LOCAL_START = /[\p{L}\p{N}_]/u;
const DOMAIN_CHAR = /[\p{L}\p{N}.-]/u;
const LABEL = /^[\p{L}\p{N}](?:[\p{L}\p{N}-]*[\p{L}\p{N}])?$/u;
const TLD = /^(?:\p{L}{2,63}|xn--[a-z0-9-]{1,59})$/iu;

/**
 * File extensions that look like a TLD after "@" (as in "icon@2x.png") but
 * are not delegated top-level domains. Extensions that are real TLDs (.app,
 * .md, .sh, .zip, .mov, ...) are deliberately absent.
 */
const FILE_EXTENSIONS = new Set([
  'avif',
  'bak',
  'bat',
  'bmp',
  'cfg',
  'cjs',
  'cpp',
  'css',
  'csv',
  'dll',
  'dmg',
  'doc',
  'docx',
  'dylib',
  'env',
  'exe',
  'flac',
  'gif',
  'heic',
  'hpp',
  'htm',
  'html',
  'ico',
  'ini',
  'iso',
  'java',
  'jpeg',
  'jpg',
  'js',
  'json',
  'jsx',
  'less',
  'lock',
  'log',
  'map',
  'mjs',
  'mkv',
  'ogg',
  'pdf',
  'php',
  'png',
  'ppt',
  'pptx',
  'psd',
  'rar',
  'sass',
  'scss',
  'svg',
  'tar',
  'tif',
  'tiff',
  'tmp',
  'toml',
  'ts',
  'tsv',
  'tsx',
  'txt',
  'wasm',
  'wav',
  'webm',
  'webp',
  'xls',
  'xlsx',
  'xml',
  'yaml',
  'yml',
]);

/** True for a character that may appear in a local part. */
export function isEmailLocalChar(char: string): boolean {
  return LOCAL_CHAR.test(char);
}

/** True for a character that may start a local part. */
export function isEmailLocalStart(char: string): boolean {
  return LOCAL_START.test(char);
}

/** True for a character that may appear in a domain. */
export function isEmailDomainChar(char: string): boolean {
  return DOMAIN_CHAR.test(char);
}

export function isValidEmailLocalPart(local: string): boolean {
  if (local.length === 0 || local.length > MAX_EMAIL_LOCAL) return false;
  if (!LOCAL_START.test(local.charAt(0))) return false;
  if (local.endsWith('.') || local.includes('..')) return false;
  for (const char of local) {
    if (!LOCAL_CHAR.test(char)) return false;
  }
  return true;
}

/** Two or more valid labels, the last a TLD that is not a file extension. */
export function isValidEmailDomain(domain: string): boolean {
  if (domain.length === 0 || domain.length > MAX_EMAIL_DOMAIN) return false;
  const labels = domain.split('.');
  if (labels.length < 2) return false;
  if (
    !labels.every((label) => label.length <= MAX_LABEL && LABEL.test(label))
  ) {
    return false;
  }
  const tld = labels[labels.length - 1] ?? '';
  return TLD.test(tld) && !FILE_EXTENSIONS.has(tld.toLowerCase());
}

/** True when the whole string is one email address under the rules above. */
export function isValidEmail(value: string): boolean {
  if (value.length > MAX_EMAIL_ADDRESS) return false;
  const at = value.lastIndexOf('@');
  if (at === -1) return false;
  return (
    isValidEmailLocalPart(value.slice(0, at)) &&
    isValidEmailDomain(value.slice(at + 1))
  );
}

/** Vault form: trimmed and lower case. */
export function normaliseEmail(value: string): string {
  return value.trim().toLowerCase();
}
