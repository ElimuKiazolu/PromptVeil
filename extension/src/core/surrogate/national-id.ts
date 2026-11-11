/**
 * NATIONAL_ID stand-ins (TR-S2): the same subtype and written form, the same
 * check characters, facts the format encodes kept consistent.
 *
 * Ranges used first (each confirmed from the issuer's own publication):
 * - US_SSN: area 666, never assigned (SSA, "Social Security Number
 *   Randomization" FAQ: randomization excludes area numbers 000, 666 and
 *   900–999). The detector rejects them.
 * - UK_NINO: prefix TN, "not to be used" (HMRC National Insurance Manual
 *   NIM39110); TN temporary numbers had the suffix M or F, never A–D, so
 *   TN + six digits + A–D was never any number. The detector rejects them.
 * - UK_NHS: 999 000 0000–999 999 9999, "a range of numbers from which real
 *   NHS numbers will never be issued" (NHS England, e-Referral Service,
 *   "Synthetic data in live environments"). Valid, so the detector still
 *   finds them (it treats the range as valid test data).
 * Every other subtype has no published never-issued or test range that
 * could be confirmed, so its stand-ins are random valid values.
 *
 * Kept from the real value: the first digit of a SIN (region, 9 for
 * temporary residents), the CPF's ninth digit (fiscal region), the PAN's
 * holder type, the CN province code, the NRIC/FIN prefix letter, the NIE
 * prefix letter, a ZA citizenship and fourth-group digit, a foreign-born
 * Italian code's Z, French Corsican/overseas/abroad department codes, and
 * the sex wherever the format encodes it (CN 17th digit parity, ZA
 * sequence half, IT day + 40, FR first digit). Birth dates (CN, ZA, IT, FR)
 * move by the conversation's date offset.
 */
import {
  luhnCheckDigit,
  mod11_10CheckDigit,
  mod11_2CheckCharacter,
  mod23Letter,
  verhoeffCheckDigit,
} from '../detect/checksum.ts';
import { cpfCheckDigits } from '../detect/rules/packs/br.ts';
import { hasValidRepetition } from '../detect/rules/packs/de.ts';
import { nirKey } from '../detect/rules/packs/fr.ts';
import { nhsCheckDigit } from '../detect/rules/packs/gb.ts';
import { isPalindrome } from '../detect/rules/packs/in.ts';
import {
  CF_MONTHS,
  CF_NUMERIC_POSITIONS,
  CF_OMOCODIA,
  cfCheckLetter,
  decodeOmocodia,
} from '../detect/rules/packs/it.ts';
import { nricCheckLetter } from '../detect/rules/packs/sg.ts';
import { isValidSsn } from '../detect/rules/packs/us.ts';
import type { NationalIdSubtype } from '../../shared/entities.ts';
import {
  calendarDay,
  fullYear,
  pad,
  shiftDate,
  type CalendarDate,
} from './dates.ts';
import { alphanumerics, applyLayout } from './layout.ts';
import { DIGITS, UPPER, type Rng } from './rng.ts';
import type { Generator, GeneratorContext } from './types.ts';

/** Draws tried for formats where a random payload can fail a rule. */
const DRAWS = 2000;
const EARLIEST: CalendarDate = { year: 1900, month: 1, day: 1 };

interface IdContext {
  readonly rng: Rng;
  /** The real value's letters and digits, upper case. */
  readonly real: string;
  readonly offset: number;
  readonly today: CalendarDate;
  readonly reservedAllowed: boolean;
}

/** Letters and digits of the stand-in (null: none this time), and if reserved. */
type IdResult = { characters: string; reserved: boolean } | null;
type IdGenerator = (context: IdContext) => IdResult;

const random = (characters: string | null): IdResult =>
  characters === null ? null : { characters, reserved: false };

/** Repeats `draw` until it gives a payload, up to DRAWS times. */
function retry(draw: () => string | null): string | null {
  for (let i = 0; i < DRAWS; i += 1) {
    const result = draw();
    if (result !== null) return result;
  }
  return null;
}

const checkDigit = (check: number | null): string | null =>
  check === null ? null : check.toString();

function shift(context: IdContext, date: CalendarDate): CalendarDate {
  return shiftDate(date, context.offset, context.today, EARLIEST);
}

// United States ----------------------------------------------------------

const ssn: IdGenerator = ({ rng, reservedAllowed }) => {
  const group = pad(rng.between(1, 99), 2);
  const serial = pad(rng.between(1, 9999), 4);
  if (reservedAllowed) {
    return { characters: `666${group}${serial}`, reserved: true };
  }
  return random(
    retry(() => {
      const value = `${pad(rng.between(1, 899), 3)}${group}${serial}`;
      return isValidSsn(value) ? value : null;
    }),
  );
};

// United Kingdom ---------------------------------------------------------

const NINO_FIRST = 'ABCEGHJKLMNOPRSTWXYZ';
const NINO_SECOND = 'ABCEGHJKLMNPRSTWXYZ';
const NINO_NOT_ALLOCATED = new Set(['BG', 'GB', 'KN', 'NK', 'NT', 'TN', 'ZZ']);

const nino: IdGenerator = ({ rng, reservedAllowed }) => {
  const digits = rng.chars(DIGITS, 6);
  const suffix = rng.char('ABCD');
  if (reservedAllowed) {
    return { characters: `TN${digits}${suffix}`, reserved: true };
  }
  return random(
    retry(() => {
      const prefix = rng.char(NINO_FIRST) + rng.char(NINO_SECOND);
      return NINO_NOT_ALLOCATED.has(prefix)
        ? null
        : `${prefix}${digits}${suffix}`;
    }),
  );
};

const nhs: IdGenerator = ({ rng, reservedAllowed }) => {
  const characters = retry(() => {
    const payload = reservedAllowed
      ? `999${rng.chars(DIGITS, 6)}`
      : `${rng.between(1, 8).toString()}${rng.chars(DIGITS, 8)}`;
    const check = nhsCheckDigit(payload);
    return check === null ? null : payload + check;
  });
  return characters === null ? null : { characters, reserved: reservedAllowed };
};

// Canada, Brazil -----------------------------------------------------------

const sin: IdGenerator = ({ rng, real }) =>
  random(
    retry(() => {
      const payload = real.charAt(0) + rng.chars(DIGITS, 7);
      const check = checkDigit(luhnCheckDigit(payload));
      return check === null ? null : payload + check;
    }),
  );

const cpf: IdGenerator = ({ rng, real }) =>
  random(
    retry(() => {
      // The ninth digit is the fiscal region of registration.
      const payload = rng.chars(DIGITS, 8) + real.charAt(8);
      const check = cpfCheckDigits(payload);
      const value = check === null ? null : payload + check;
      return value === null || /^(\d)\1*$/u.test(value) ? null : value;
    }),
  );

// India ------------------------------------------------------------------

function verhoeffNumber(rng: Rng, length: number): string | null {
  return retry(() => {
    const payload = rng.char('23456789') + rng.chars(DIGITS, length - 2);
    const check = checkDigit(verhoeffCheckDigit(payload));
    if (check === null) return null;
    const value = payload + check;
    return isPalindrome(value) ? null : value;
  });
}

const aadhaar: IdGenerator = ({ rng }) => random(verhoeffNumber(rng, 12));
const vid: IdGenerator = ({ rng }) => random(verhoeffNumber(rng, 16));

const pan: IdGenerator = ({ rng, real }) => {
  const serial = retry(() => {
    const digits = rng.chars(DIGITS, 4);
    return digits === '0000' ? null : digits;
  });
  if (serial === null) return null;
  return random(
    // The fourth letter is the holder type.
    `${rng.chars(UPPER, 3)}${real.charAt(3)}${rng.char(UPPER)}${serial}${rng.char(UPPER)}`,
  );
};

// China, Singapore, South Africa -------------------------------------------

const ric: IdGenerator = (context) => {
  const { rng, real } = context;
  const born = shift(context, {
    year: Number(real.slice(6, 10)),
    month: Number(real.slice(10, 12)),
    day: Number(real.slice(12, 14)),
  });
  // Odd 17th digit: male; even: female.
  const sex = Number(real.charAt(16)) % 2;
  const payload =
    real.slice(0, 2) +
    rng.chars(DIGITS, 4) +
    pad(born.year, 4) +
    pad(born.month, 2) +
    pad(born.day, 2) +
    rng.chars(DIGITS, 2) +
    (rng.int(5) * 2 + sex).toString();
  const check = mod11_2CheckCharacter(payload);
  return random(check === null ? null : payload + check);
};

const nric: IdGenerator = ({ rng, real }) => {
  const prefix = real.charAt(0);
  const digits = rng.chars(DIGITS, 7);
  const check = nricCheckLetter(prefix, digits);
  return random(check === null ? null : `${prefix}${digits}${check}`);
};

const zaId: IdGenerator = (context) => {
  const { rng, real } = context;
  const yy = Number(real.slice(0, 2));
  const born = shift(context, {
    year: fullYear(yy, context.today),
    month: Number(real.slice(2, 4)),
    day: Number(real.slice(4, 6)),
  });
  // 0000–4999 female, 5000–9999 male.
  const male = Number(real.slice(6, 10)) >= 5000;
  const sequence = pad(rng.between(male ? 5000 : 0, male ? 9999 : 4999), 4);
  const payload =
    pad(born.year % 100, 2) +
    pad(born.month, 2) +
    pad(born.day, 2) +
    sequence +
    real.slice(10, 12);
  return random(payload + (checkDigit(luhnCheckDigit(payload)) ?? ''));
};

// Spain, Italy, France, Germany ------------------------------------------

const NIE_DIGIT: Readonly<Record<string, string>> = { X: '0', Y: '1', Z: '2' };

const dni: IdGenerator = ({ rng, real }) => {
  const prefix = real.charAt(0);
  const nieDigit = NIE_DIGIT[prefix];
  if (nieDigit !== undefined) {
    const digits = rng.chars(DIGITS, 7);
    const letter = mod23Letter(nieDigit + digits);
    return random(letter === null ? null : `${prefix}${digits}${letter}`);
  }
  const digits = rng.chars(DIGITS, 8);
  const letter = mod23Letter(digits);
  return random(letter === null ? null : `${digits}${letter}`);
};

const CF_LETTERS = 'BCDFGHJKLMNPQRSTVWXYZ';

const cf: IdGenerator = (context) => {
  const { rng, real } = context;
  const decoded = decodeOmocodia(real);
  const rawDay = Number(decoded.slice(9, 11));
  const female = rawDay > 40;
  const born = shift(context, {
    year: fullYear(Number(decoded.slice(6, 8)), context.today),
    month: CF_MONTHS.indexOf(decoded.charAt(8)) + 1,
    day: female ? rawDay - 40 : rawDay,
  });
  const foreign = real.charAt(11) === 'Z';
  const place =
    (foreign ? 'Z' : rng.char('ABCDEFGHILM')) + rng.chars(DIGITS, 3);
  let code =
    rng.chars(CF_LETTERS, 6) +
    pad(born.year % 100, 2) +
    CF_MONTHS.charAt(born.month - 1) +
    pad(born.day + (female ? 40 : 0), 2) +
    place;
  // Omocodia: numeric positions written as letters stay letters.
  for (const position of CF_NUMERIC_POSITIONS) {
    const char = real.charAt(position);
    if (char >= 'A' && char <= 'Z') {
      const letter = CF_OMOCODIA.charAt(Number(code.charAt(position)));
      code = code.slice(0, position) + letter + code.slice(position + 1);
    }
  }
  const check = cfCheckLetter(code);
  return random(check === null ? null : code + check);
};

const nir: IdGenerator = (context) => {
  const { rng, real } = context;
  let yearMonth = real.slice(1, 5);
  const month = Number(real.slice(3, 5));
  if (month >= 1 && month <= 12) {
    const born = shift(context, {
      year: fullYear(Number(real.slice(1, 3)), context.today),
      month,
      day: 15,
    });
    yearMonth = pad(born.year % 100, 2) + pad(born.month, 2);
  }
  const department = real.slice(5, 7);
  // Corsica (2A, 2B), overseas (97, 98) and born abroad (99) stay as they
  // are; any other department becomes a random metropolitan one.
  // (20 was Corsica's code before 2A/2B.)
  const keep = ['2A', '2B', '97', '98', '99'].includes(department);
  const drawn = rng.between(1, 94);
  const newDepartment = keep
    ? department
    : pad(drawn >= 20 ? drawn + 1 : drawn, 2);
  const first13 =
    real.charAt(0) +
    yearMonth +
    newDepartment +
    pad(rng.between(1, 990), 3) +
    pad(rng.between(1, 999), 3);
  const key = nirKey(first13);
  return random(key === null ? null : first13 + key);
};

/**
 * Ten digits with exactly one digit twice: the digits 0–9 shuffled, then one
 * position overwritten with a copy of another (that digit's twin is never
 * adjacent three times, as only two exist). A leading 0 is drawn again.
 */
const taxId: IdGenerator = ({ rng }) =>
  random(
    retry(() => {
      const digits = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'];
      for (let i = digits.length - 1; i > 0; i -= 1) {
        const j = rng.int(i + 1);
        [digits[i], digits[j]] = [digits[j] ?? '0', digits[i] ?? '0'];
      }
      const from = rng.int(10);
      const to = (from + 1 + rng.int(9)) % 10;
      digits[to] = digits[from] ?? '0';
      const first10 = digits.join('');
      if (first10.startsWith('0') || !hasValidRepetition(first10)) return null;
      const check = checkDigit(mod11_10CheckDigit(first10));
      return check === null ? null : first10 + check;
    }),
  );

const GENERATORS: Readonly<Record<NationalIdSubtype, IdGenerator>> = {
  US_SSN: ssn,
  UK_NINO: nino,
  UK_NHS: nhs,
  CA_SIN: sin,
  BR_CPF: cpf,
  IN_AADHAAR: aadhaar,
  IN_VID: vid,
  IN_PAN: pan,
  CN_RIC: ric,
  SG_NRIC: nric,
  ZA_ID: zaId,
  ES_DNI: dni,
  IT_CF: cf,
  FR_NIR: nir,
  DE_TAXID: taxId,
};

export function isNationalIdSubtype(
  subtype: string | null,
): subtype is NationalIdSubtype {
  return subtype !== null && Object.hasOwn(GENERATORS, subtype);
}

export const nationalIdStandIn: Generator = (context: GeneratorContext) => {
  const { request } = context;
  if (!isNationalIdSubtype(request.subtype)) return null;
  const result = GENERATORS[request.subtype]({
    rng: context.rng,
    real: alphanumerics(request.value).toUpperCase(),
    offset: request.dateOffsetDays,
    today: calendarDay(request.now),
    reservedAllowed: context.reservedAllowed,
  });
  if (result === null) return null;
  return {
    value: applyLayout(request.value, result.characters),
    reserved: result.reserved,
  };
};
