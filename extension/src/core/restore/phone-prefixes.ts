/**
 * Dialling prefixes from libphonenumber-js 1.13.14's metadata, for finding a
 * phone number written in another form than the one shown to the chatbot.
 *
 * - National (trunk) prefix per country calling code: the digits dialled
 *   before the national significant number inside the country ("0" in most,
 *   "1" in NANP, "8" in Russia and Kazakhstan, "06" in Hungary, none in e.g.
 *   Italy, Spain or Poland, where a leading 0 belongs to the number). Every
 *   region sharing a calling code has the same one.
 * - International dialling prefixes: those of every region, written with
 *   digits only (the prefix depends on where the number is dialled from, not
 *   on the number). The single "0" two regions use is left out, since it
 *   reads like a trunk prefix.
 *
 * A test re-derives both from the installed metadata; regenerate them when
 * libphonenumber-js is upgraded.
 */

/** Calling codes whose national prefix is "0". */
const TRUNK_ZERO: ReadonlySet<string> = new Set(
  '20 27 31 32 33 40 41 43 44 46 49 51 53 54 55 57 58 60 61 62 63 64 66 81 82 84 86 90 91 92 93 94 95 98 211 212 213 218 231 232 233 234 243 249 250 251 252 254 255 256 260 261 262 263 264 265 291 353 355 358 359 370 373 374 377 380 381 382 383 385 386 387 389 421 423 508 590 591 593 594 595 596 598 686 850 855 856 880 886 961 962 963 964 966 967 970 971 972 976 977 994 995 996'.split(
    ' ',
  ),
);

const OTHER_NATIONAL_PREFIXES: Readonly<Record<string, string>> = {
  '1': '1',
  '7': '8',
  '36': '06',
  '375': '8',
  '692': '1',
  '993': '8',
};

export const INTERNATIONAL_PREFIXES: readonly string[] = [
  '00',
  '000',
  '001',
  '009',
  '010',
  '011',
  '020',
  '119',
  '810',
  '0011',
];

/** The national prefix for numbers with this calling code, or null. */
export function nationalPrefix(callingCode: string): string | null {
  if (TRUNK_ZERO.has(callingCode)) return '0';
  return OTHER_NATIONAL_PREFIXES[callingCode] ?? null;
}
