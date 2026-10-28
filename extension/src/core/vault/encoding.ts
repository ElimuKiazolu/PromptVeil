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
