/**
 * Unambiguous byte encoding of field lists, used as AES-GCM additional data
 * and as HMAC input. Each field is a 1-byte tag (0 = null, 1 = string), then
 * for strings a 4-byte big-endian length and the UTF-8 bytes. Different
 * field lists can never encode to the same bytes: ("AB", "C") ≠ ("A", "BC"),
 * null ≠ "".
 */

const encoder = new TextEncoder();

export function encodeFields(
  fields: readonly (string | null)[],
): Uint8Array<ArrayBuffer> {
  const parts = fields.map((field) =>
    field === null ? null : encoder.encode(field),
  );
  const size = parts.reduce(
    (total, part) => total + 1 + (part === null ? 0 : 4 + part.length),
    0,
  );
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  let offset = 0;
  for (const part of parts) {
    if (part === null) {
      out[offset] = 0;
      offset += 1;
      continue;
    }
    out[offset] = 1;
    view.setUint32(offset + 1, part.length);
    out.set(part, offset + 5);
    offset += 5 + part.length;
  }
  return out;
}

/** Standard base64 with padding. */
export function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

const decoder = new TextDecoder('utf-8', { fatal: true });

/**
 * The fields of an encodeFields result, or null when the bytes are not
 * exactly one well-formed field list (truncated, trailing bytes, unknown
 * tag, invalid UTF-8).
 */
export function decodeFields(bytes: Uint8Array): (string | null)[] | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const fields: (string | null)[] = [];
  let offset = 0;
  while (offset < bytes.length) {
    const tag = bytes[offset];
    if (tag === 0) {
      fields.push(null);
      offset += 1;
      continue;
    }
    if (tag !== 1 || offset + 5 > bytes.length) return null;
    const length = view.getUint32(offset + 1);
    const start = offset + 5;
    if (start + length > bytes.length) return null;
    try {
      fields.push(decoder.decode(bytes.subarray(start, start + length)));
    } catch {
      return null;
    }
    offset = start + length;
  }
  return fields;
}
