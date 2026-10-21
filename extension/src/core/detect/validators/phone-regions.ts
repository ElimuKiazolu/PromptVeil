/**
 * Fast pre-check for the all-region phone pass: can parsing `digits` as a
 * national number with default region R give a valid number at all?
 *
 * Exactness. Parsing with libphonenumber-js (1.13.x, `parse.js` and helpers)
 * depends on R only in these ways:
 * 1. If R's international dialling prefix (IDD) matches at the start, the
 *    rest is parsed as an international number.
 * 2. If the digits start with R's calling code, the rest may be taken as the
 *    national part of that calling code and parsed with its main region's
 *    plan.
 * 3. Otherwise R's plan extracts the national significant number (NSN): the
 *    digits as they are, or with R's national prefix match removed, or, if R
 *    has a national prefix transform rule, the digits rewritten by it.
 * In cases 2 and 3 the number is valid only if the NSN fits a number type
 * (pattern and length) of a region with R's calling code, because
 * isValid() looks the NSN up in exactly those regions.
 *
 * So R is skipped only when (1) its IDD does not match, (2) no region of its
 * calling code has a transform rule (the only way the NSN can be anything but
 * a suffix of the digits), and (3) none of the possible NSNs (the digits,
 * the digits without R's national prefix, and the same two for the digits
 * after R's calling code, with any of that calling code's national prefixes)
 * fits any number type of that calling code's regions. Every skipped region
 * would have failed to parse; the full-scan comparison test checks this.
 *
 * Metadata accessors outside the library's typings are read defensively: if
 * one is missing, the region is always parsed (slower, never wrong).
 */
import {
  Metadata,
  getCountries,
  getCountryCallingCode,
  type CountryCode as PhoneRegion,
} from 'libphonenumber-js/max';

/** Number types that isValid() accepts (getNumberType in libphonenumber-js). */
const NUMBER_TYPES = [
  'FIXED_LINE',
  'MOBILE',
  'PREMIUM_RATE',
  'TOLL_FREE',
  'SHARED_COST',
  'VOIP',
  'PERSONAL_NUMBER',
  'PAGER',
  'UAN',
  'VOICEMAIL',
] as const;

/** Shortest NSN libphonenumber accepts. */
const MIN_NSN_LENGTH = 2;

interface TypePattern {
  /** Allowed NSN lengths; null when the metadata gives none. */
  lengths: ReadonlySet<number> | null;
  pattern: RegExp;
}

interface RegionEntry {
  region: PhoneRegion;
  callingCode: string;
  /** Always parse: IDD unknown, or metadata shape not as expected. */
  alwaysParse: boolean;
  idd: RegExp | null;
  nationalPrefix: RegExp | null;
}

interface CallingCodeEntry {
  /** A region of this calling code rewrites national numbers (case 3). */
  hasTransformRule: boolean;
  /** Some region's types could not be read: never skip. */
  unknownTypes: boolean;
  types: TypePattern[];
  nationalPrefixes: RegExp[];
}

export interface RegionIndex {
  readonly regions: readonly RegionEntry[];
  readonly callingCodes: ReadonlyMap<string, CallingCodeEntry>;
}

/** Calls a no-argument method by name, if there is one. */
function callMethod(
  target: unknown,
  name: string,
  ...args: unknown[]
): unknown {
  if (typeof target !== 'object' || target === null) return undefined;
  const method: unknown = Reflect.get(target, name);
  if (typeof method !== 'function') return undefined;
  return Reflect.apply(method, target, args) as unknown;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function asLengths(value: unknown): ReadonlySet<number> | null {
  if (!Array.isArray(value)) return null;
  const lengths = new Set<number>();
  for (const item of value) {
    if (typeof item === 'number') lengths.add(item);
  }
  return lengths.size > 0 ? lengths : null;
}

/* No "u" flag: the metadata patterns are written for non-Unicode mode, as the library compiles them. */
function anchoredStart(source: string): RegExp {
  return new RegExp(`^(?:${source})`);
}

function anchoredWhole(source: string): RegExp {
  return new RegExp(`^(?:${source})$`);
}

/** The region's number types, or null if they cannot be read. */
function readTypes(plan: unknown): TypePattern[] | null {
  const hasTypes = callMethod(plan, 'hasTypes');
  if (typeof hasTypes !== 'boolean') return null;
  if (!hasTypes) {
    // Without types, isValid() matches the general national number pattern.
    const general = asString(callMethod(plan, 'nationalNumberPattern'));
    return general === null
      ? null
      : [{ lengths: null, pattern: anchoredWhole(general) }];
  }
  const types: TypePattern[] = [];
  for (const name of NUMBER_TYPES) {
    const type = callMethod(plan, 'type', name);
    if (type === undefined) continue;
    const pattern = asString(callMethod(type, 'pattern'));
    if (pattern === null) continue;
    types.push({
      lengths: asLengths(callMethod(type, 'possibleLengths')),
      pattern: anchoredWhole(pattern),
    });
  }
  return types;
}

/**
 * Builds the index one region per step, so the work can be spread over
 * several tasks (see schedule.ts).
 */
export function* buildRegionIndex(): Generator<void, RegionIndex> {
  const metadata = new Metadata();
  const regions: RegionEntry[] = [];
  const callingCodes = new Map<string, CallingCodeEntry>();
  for (const region of getCountries()) {
    metadata.selectNumberingPlan(region);
    const plan = metadata.numberingPlan;
    const callingCode = getCountryCallingCode(region);
    let entry = callingCodes.get(callingCode);
    if (entry === undefined) {
      entry = {
        hasTransformRule: false,
        unknownTypes: false,
        types: [],
        nationalPrefixes: [],
      };
      callingCodes.set(callingCode, entry);
    }

    const idd = asString(plan?.IDDPrefix());
    const prefix = asString(callMethod(plan, 'nationalPrefixForParsing'));
    if (asString(callMethod(plan, 'nationalPrefixTransformRule')) !== null) {
      entry.hasTransformRule = true;
    }
    const types = readTypes(plan);
    if (types === null) entry.unknownTypes = true;
    else entry.types.push(...types);
    const nationalPrefix = prefix === null ? null : anchoredStart(prefix);
    if (nationalPrefix !== null) entry.nationalPrefixes.push(nationalPrefix);

    regions.push({
      region,
      callingCode,
      alwaysParse: plan === undefined || idd === null,
      idd: idd === null ? null : anchoredStart(idd),
      nationalPrefix,
    });
    yield;
  }
  return { regions, callingCodes };
}

function withoutPrefix(digits: string, prefix: RegExp | null): string | null {
  if (prefix === null) return null;
  const match = prefix.exec(digits);
  return match === null ? null : digits.slice(match[0].length);
}

function fitsType(entry: CallingCodeEntry, nsn: string | null): boolean {
  if (nsn === null || nsn.length < MIN_NSN_LENGTH) return false;
  return entry.types.some(
    (type) =>
      (type.lengths === null || type.lengths.has(nsn.length)) &&
      type.pattern.test(nsn),
  );
}

/**
 * False only when parsing `digits` (ASCII digits of a national-format
 * number) with this default region cannot give a valid number.
 */
export function mayAccept(
  index: RegionIndex,
  region: RegionEntry,
  digits: string,
): boolean {
  if (region.alwaysParse || region.idd === null) return true;
  const entry = index.callingCodes.get(region.callingCode);
  if (entry === undefined || entry.unknownTypes || entry.hasTransformRule) {
    return true;
  }
  if (region.idd.test(digits)) return true;
  if (fitsType(entry, digits)) return true;
  if (fitsType(entry, withoutPrefix(digits, region.nationalPrefix)))
    return true;
  if (!digits.startsWith(region.callingCode)) return false;
  const rest = digits.slice(region.callingCode.length);
  if (fitsType(entry, rest)) return true;
  return entry.nationalPrefixes.some((prefix) =>
    fitsType(entry, withoutPrefix(rest, prefix)),
  );
}
