/**
 * Check-digit algorithms used by the validators and stand-in generators.
 *
 * Pure functions over strings of ASCII digits (letters only where a scheme
 * defines them). Separators are the caller's job: any other character makes
 * a validator return false and a check-digit function return null. All
 * arithmetic is digit by digit, so input length never causes overflow.
 */

const ZERO = 48;
const NINE = 57;
const UPPER_A = 65;
const UPPER_Z = 90;

/** Digit value 0–9 of the character at `index`, or -1. */
function digitAt(value: string, index: number): number {
  const code = value.charCodeAt(index);
  return code >= ZERO && code <= NINE ? code - ZERO : -1;
}

export function isDigits(value: string): boolean {
  if (value.length === 0) return false;
  for (let i = 0; i < value.length; i += 1) {
    if (digitAt(value, i) === -1) return false;
  }
  return true;
}

// Luhn (ISO/IEC 7812-1 annex B) ----------------------------------------------

/** Luhn sum with doubling starting `offset` places from the right (0 or 1). */
function luhnSum(digits: string, offset: 0 | 1): number {
  let sum = 0;
  for (let i = digits.length - 1, place = offset; i >= 0; i -= 1, place += 1) {
    let digit = digitAt(digits, i);
    if (place % 2 === 1) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
  }
  return sum;
}

/** True when the last digit is the Luhn check digit of the rest. */
export function isValidLuhn(value: string): boolean {
  if (value.length < 2 || !isDigits(value)) return false;
  return luhnSum(value, 0) % 10 === 0;
}

/** The Luhn check digit to append to `payload`. */
export function luhnCheckDigit(payload: string): number | null {
  if (!isDigits(payload)) return null;
  return (10 - (luhnSum(payload, 1) % 10)) % 10;
}

// Verhoeff (dihedral group D5) ------------------------------------------------

const VERHOEFF_D: readonly (readonly number[])[] = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 2, 3, 4, 0, 6, 7, 8, 9, 5],
  [2, 3, 4, 0, 1, 7, 8, 9, 5, 6],
  [3, 4, 0, 1, 2, 8, 9, 5, 6, 7],
  [4, 0, 1, 2, 3, 9, 5, 6, 7, 8],
  [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
  [6, 5, 9, 8, 7, 1, 0, 4, 3, 2],
  [7, 6, 5, 9, 8, 2, 1, 0, 4, 3],
  [8, 7, 6, 5, 9, 3, 2, 1, 0, 4],
  [9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
];

const VERHOEFF_P: readonly (readonly number[])[] = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 5, 7, 6, 2, 8, 3, 0, 9, 4],
  [5, 8, 0, 3, 7, 9, 6, 1, 4, 2],
  [8, 9, 1, 6, 0, 4, 3, 5, 2, 7],
  [9, 4, 5, 3, 1, 2, 6, 8, 7, 0],
  [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
  [2, 7, 9, 3, 8, 0, 6, 4, 1, 5],
  [7, 0, 4, 6, 9, 1, 3, 2, 5, 8],
];

const VERHOEFF_INV: readonly number[] = [0, 4, 3, 2, 1, 5, 6, 7, 8, 9];

function table(rows: readonly (readonly number[])[], r: number, c: number) {
  // Indices are always in range (digits 0–9, r mod 8); the fallback only
  // satisfies the index-access check.
  return rows[r]?.[c] ?? 0;
}

function verhoeffState(digits: string, offset: 0 | 1): number {
  let c = 0;
  for (let i = digits.length - 1, place = offset; i >= 0; i -= 1, place += 1) {
    const p = table(VERHOEFF_P, place % 8, digitAt(digits, i));
    c = table(VERHOEFF_D, c, p);
  }
  return c;
}

export function isValidVerhoeff(value: string): boolean {
  if (value.length < 2 || !isDigits(value)) return false;
  return verhoeffState(value, 0) === 0;
}

export function verhoeffCheckDigit(payload: string): number | null {
  if (!isDigits(payload)) return null;
  return VERHOEFF_INV[verhoeffState(payload, 1)] ?? null;
}

// ISO 7064 MOD 11-2 (pure system, check character 0–9 or X) ------------------

function mod11_2Check(payload: string): string {
  let p = 0;
  for (let i = 0; i < payload.length; i += 1) {
    p = ((p + digitAt(payload, i)) * 2) % 11;
  }
  const check = (12 - p) % 11;
  return check === 10 ? 'X' : check.toString();
}

/** The check character (`0`–`9` or `X`) to append to `payload`. */
export function mod11_2CheckCharacter(payload: string): string | null {
  return isDigits(payload) ? mod11_2Check(payload) : null;
}

/** Digits followed by a MOD 11-2 check character; `X` must be upper case. */
export function isValidMod11_2(value: string): boolean {
  if (value.length < 2) return false;
  const payload = value.slice(0, -1);
  return isDigits(payload) && mod11_2Check(payload) === value.slice(-1);
}

// ISO 7064 MOD 11,10 (hybrid system) ------------------------------------------

function mod11_10Check(payload: string): number {
  let p = 10;
  for (let i = 0; i < payload.length; i += 1) {
    const s = (p + digitAt(payload, i)) % 10 || 10;
    p = (s * 2) % 11;
  }
  return (11 - p) % 10;
}

export function mod11_10CheckDigit(payload: string): number | null {
  return isDigits(payload) ? mod11_10Check(payload) : null;
}

export function isValidMod11_10(value: string): boolean {
  if (value.length < 2 || !isDigits(value)) return false;
  return mod11_10Check(value.slice(0, -1)) === digitAt(value, value.length - 1);
}

// ISO 7064 MOD 97-10 and ISO 13616 (IBAN) ------------------------------------

/**
 * Remainder mod 97 of a digit string, where letters A–Z count as the
 * two-digit numbers 10–35 (the ISO 13616 conversion; digit-only input is
 * plain ISO 7064). Null for empty input or any other character.
 */
export function mod97(value: string): number | null {
  if (value.length === 0) return null;
  let remainder = 0;
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code >= ZERO && code <= NINE) {
      remainder = (remainder * 10 + (code - ZERO)) % 97;
    } else if (code >= UPPER_A && code <= UPPER_Z) {
      remainder = (remainder * 100 + (code - UPPER_A + 10)) % 97;
    } else {
      return null;
    }
  }
  return remainder;
}

/** Digits ending in two MOD 97-10 check digits. */
export function isValidMod97_10(value: string): boolean {
  return value.length > 2 && isDigits(value) && mod97(value) === 1;
}

/** The two check digits (`02`–`98`) to append to a digit payload. */
export function mod97_10CheckDigits(payload: string): string | null {
  if (!isDigits(payload)) return null;
  const remainder = mod97(`${payload}00`) ?? 0;
  return (98 - remainder).toString().padStart(2, '0');
}

// Weighted mod 11 -------------------------------------------------------------

/**
 * Sum of digit × weight, mod 11, with one weight per digit (left to right).
 * Schemes differ in how they turn this into a check digit (11 − r, r, with
 * 10 rejected or mapped), so that step stays with each scheme.
 */
export function weightedMod11(
  digits: string,
  weights: readonly number[],
): number | null {
  if (!isDigits(digits) || digits.length !== weights.length) return null;
  let sum = 0;
  for (let i = 0; i < digits.length; i += 1) {
    sum += digitAt(digits, i) * (weights[i] ?? 0);
  }
  return sum % 11;
}

// Mod 23 letter (Spanish DNI / NIE) -------------------------------------------

const MOD23_LETTERS = 'TRWAGMYFPDXBNJZSQVHLCKE';

/**
 * The control letter for a DNI number (NIE: replace X/Y/Z by 0/1/2 first),
 * as published by the Spanish Ministry of the Interior.
 */
export function mod23Letter(digits: string): string | null {
  if (!isDigits(digits)) return null;
  let remainder = 0;
  for (let i = 0; i < digits.length; i += 1) {
    remainder = (remainder * 10 + digitAt(digits, i)) % 23;
  }
  return MOD23_LETTERS.charAt(remainder);
}
