/**
 * Normal form of a stand-in, used for collision checks within a
 * conversation. (The normal form of a real value comes with the value; see
 * src/core/detect/normal-form.ts.)
 */

/** Normal form of a stand-in: NFC, lower case, separators removed. */
export function normaliseStandIn(value: string): string {
  return value
    .normalize('NFC')
    .toLowerCase()
    .replace(/[\s./()-]/gu, '');
}
