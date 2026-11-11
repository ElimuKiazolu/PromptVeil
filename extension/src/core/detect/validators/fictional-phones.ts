/**
 * Telephone number ranges that regulators reserve for fiction (drama,
 * films, advertising): no subscriber is ever given one. The detector does
 * not report numbers in them (they are not anyone's data), and the stand-in
 * engine takes PHONE stand-ins from them first, so a stand-in is never
 * detected as a real number again.
 *
 * Sources:
 * - United Kingdom: Ofcom, "Telephone numbers for use in TV and radio drama
 *   programmes" (ofcom.org.uk/phones-and-broadband/phone-numbers/numbers-for-drama):
 *   1,000 numbers per range, "will not be allocated to communications
 *   providers in the foreseeable future"; 01632 960xxx is the range for any
 *   area code not listed.
 * - United States, Canada and the other NANP countries: NANPA, "555 line
 *   numbers" (nanpa.com/numbering/555-line-numbers): "the fictitious,
 *   non-working numbers, 555-0100 through 555-0199, will remain reserved for
 *   entertainment/advertising", in every area code.
 * - France: Arcep decision 2018-0881 establishing the national numbering
 *   plan, section 2.5.12 "Numéros pour œuvres audiovisuelles": roots
 *   01 99 00, 02 61 91, 03 53 01, 04 65 71, 05 36 49 and 06 39 98, which may
 *   not be assigned to end users.
 * - Australia: ACMA, "Phone numbers for use in TV shows, films and creative
 *   works": 5550 xxxx and 7010 xxxx in each of the areas (02), (03), (07)
 *   and (08). The ACMA's individual mobile and 1800/1300 numbers are not
 *   listed here (the full list could not be retrieved from the ACMA).
 */
import {
  isSupportedCountry,
  parsePhoneNumberFromString,
} from 'libphonenumber-js/max';
import type { CountryCode } from '../../../shared/country.ts';
import type { PhoneType } from './phone.ts';

/** The kind of number a range holds, in libphonenumber's terms. */
export type FictionalPhoneKind =
  | 'MOBILE'
  | 'FIXED_LINE'
  | 'TOLL_FREE'
  | 'PREMIUM_RATE'
  | 'UAN'
  /** Any NANP number type (NANP numbers are fixed line or mobile alike). */
  | 'ANY';

export interface FictionalPhoneRange {
  /** Without "+". */
  readonly callingCode: string;
  readonly kind: FictionalPhoneKind;
  /**
   * The national significant number: fixed digits, "#" for a free digit,
   * "K" for a digit kept from the number the range stands in for (the NANP
   * area code).
   */
  readonly pattern: string;
  /**
   * Leading digits of the national significant number that identify the
   * area (geographic ranges), so a stand-in keeps the real number's area
   * when a range exists for it.
   */
  readonly area: string | null;
}

const range = (
  callingCode: string,
  kind: FictionalPhoneKind,
  pattern: string,
  area: string | null = null,
): FictionalPhoneRange => ({ callingCode, kind, pattern, area });

const OFCOM_AREAS = [
  '113',
  '114',
  '115',
  '116',
  '117',
  '118',
  '121',
  '131',
  '141',
  '151',
  '161',
] as const;

const ARCEP_ROOTS = [
  ['1', '19900'],
  ['2', '26191'],
  ['3', '35301'],
  ['4', '46571'],
  ['5', '53649'],
] as const;

export const FICTIONAL_PHONE_RANGES: readonly FictionalPhoneRange[] = [
  // Ofcom: geographic areas with a range of their own (area code + 496 0xxx).
  ...OFCOM_AREAS.map((area) =>
    range('44', 'FIXED_LINE', `${area}4960###`, area),
  ),
  range('44', 'FIXED_LINE', '2079460###', '20'),
  range('44', 'FIXED_LINE', '1914980###', '191'),
  range('44', 'FIXED_LINE', '2896496###', '28'),
  range('44', 'FIXED_LINE', '2920180###', '29'),
  // Ofcom: "no area" range, for any other area code.
  range('44', 'FIXED_LINE', '1632960###'),
  range('44', 'MOBILE', '7700900###'),
  range('44', 'TOLL_FREE', '8081570###'),
  range('44', 'PREMIUM_RATE', '9098790###'),
  range('44', 'UAN', '3069990###'),
  // NANPA: 555-0100 to 555-0199 under every area code.
  range('1', 'ANY', 'KKK55501##'),
  // Arcep: geographic roots (zones 1–5) and the mobile root.
  ...ARCEP_ROOTS.map(([area, root]) =>
    range('33', 'FIXED_LINE', `${root}####`, area),
  ),
  range('33', 'MOBILE', '63998####'),
  // ACMA: 5550 xxxx and 7010 xxxx in each geographic area.
  ...['2', '3', '7', '8'].flatMap((area) => [
    range('61', 'FIXED_LINE', `${area}5550####`, area),
    range('61', 'FIXED_LINE', `${area}7010####`, area),
  ]),
];

/** True when the national significant number fits the range's pattern. */
export function inFictionalRange(
  range: FictionalPhoneRange,
  nationalNumber: string,
): boolean {
  if (nationalNumber.length !== range.pattern.length) return false;
  for (let i = 0; i < range.pattern.length; i += 1) {
    const slot = range.pattern.charAt(i);
    const digit = nationalNumber.charAt(i);
    if (digit < '0' || digit > '9') return false;
    if (slot !== '#' && slot !== 'K' && slot !== digit) return false;
  }
  return true;
}

/** True for a number in a range reserved for fiction. */
export function isFictionalPhone(
  callingCode: string,
  nationalNumber: string,
): boolean {
  return FICTIONAL_PHONE_RANGES.some(
    (entry) =>
      entry.callingCode === callingCode &&
      inFictionalRange(entry, nationalNumber),
  );
}

/** True when a range of this kind can stand in for a number of this type. */
export function kindFits(
  kind: FictionalPhoneKind,
  type: PhoneType | null,
): boolean {
  if (kind === 'ANY') return true;
  if (type === kind) return true;
  return (
    type === 'FIXED_LINE_OR_MOBILE' &&
    (kind === 'FIXED_LINE' || kind === 'MOBILE')
  );
}

const SPACES = /[\u00A0\u2007\u2009\u202F]/gu;

/**
 * True when the written number is in a range reserved for fiction, read as
 * international ("+…") or in one of the regions. Many of these numbers are
 * not valid for libphonenumber in their own region (e.g. 07700 900xxx), so
 * the detector checks this before looking for readings in other regions.
 */
export function isFictionalWritten(
  raw: string,
  regions: readonly CountryCode[],
): boolean {
  const input = raw.replace(SPACES, ' ');
  const readings = raw.trimStart().startsWith('+')
    ? [undefined]
    : regions.filter((region) => isSupportedCountry(region));
  return readings.some((region) => {
    const phone = parsePhoneNumberFromString(input, {
      defaultCountry: region,
      extract: false,
    });
    return (
      phone !== undefined &&
      isFictionalPhone(phone.countryCallingCode, phone.nationalNumber)
    );
  });
}
