export interface Span {
  /** Index of the first UTF-16 code unit. */
  start: number;
  /** Index just past the last code unit. */
  end: number;
  value: string;
}

const MAX_LOCAL = 64;
const MAX_DOMAIN = 253;
const MAX_ADDRESS = 254;
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

/** Local part immediately before index `at`, or null if there is none. */
function localPartStart(text: string, at: number): number | null {
  let start = at;
  // Scan one character past the limit so over-long runs can be rejected.
  while (
    start > 0 &&
    at - start <= MAX_LOCAL &&
    LOCAL_CHAR.test(text.charAt(start - 1))
  ) {
    start -= 1;
  }
  if (at - start > MAX_LOCAL) return null;

  // Text after a double dot is the address; anything before it is not.
  const doubleDot = text.slice(start, at).lastIndexOf('..');
  if (doubleDot !== -1) start += doubleDot + 2;
  // Leading punctuation (quotes, dashes, dots) belongs to the surrounding text.
  while (start < at && !LOCAL_START.test(text.charAt(start))) start += 1;

  if (start === at || text.charAt(at - 1) === '.') return null;
  return start;
}

/** End of a valid domain starting at `from`, or null if there is none. */
function domainEnd(text: string, from: number): number | null {
  let end = from;
  while (
    end < text.length &&
    end - from <= MAX_DOMAIN &&
    DOMAIN_CHAR.test(text.charAt(end))
  ) {
    end += 1;
  }
  const doubleDot = text.slice(from, end).indexOf('..');
  if (doubleDot !== -1) end = from + doubleDot;
  // A trailing full stop or hyphen belongs to the sentence, not the domain.
  while (end > from && /[.-]/.test(text.charAt(end - 1))) end -= 1;
  if (end - from > MAX_DOMAIN) return null;

  const labels = text.slice(from, end).split('.');
  if (labels.length < 2) return null;
  if (
    !labels.every((label) => label.length <= MAX_LABEL && LABEL.test(label))
  ) {
    return null;
  }
  const tld = labels[labels.length - 1] ?? '';
  if (!TLD.test(tld) || FILE_EXTENSIONS.has(tld.toLowerCase())) return null;
  return end;
}

/**
 * Finds email addresses in free text.
 *
 * Works outward from each "@" with bounded scans, so the cost stays linear in
 * the input length however the text is shaped.
 */
export function detectEmails(text: string): Span[] {
  const spans: Span[] = [];
  let lastEnd = 0;
  for (let at = text.indexOf('@'); at !== -1; at = text.indexOf('@', at + 1)) {
    const start = localPartStart(text, at);
    if (start === null || start < lastEnd) continue;
    const end = domainEnd(text, at + 1);
    if (end === null || end - start > MAX_ADDRESS) continue;
    spans.push({ start, end, value: text.slice(start, end) });
    lastEnd = end;
  }
  return spans;
}
