const digits = (value: string): number[] =>
  (value.match(/\d/g) ?? []).map(Number);

/** Luhn check over all digits of the value. */
export function luhnValid(value: string): boolean {
  const sum = digits(value)
    .reverse()
    .reduce((total, digit, index) => {
      if (index % 2 === 0) return total + digit;
      const doubled = digit * 2;
      return total + (doubled > 9 ? doubled - 9 : doubled);
    }, 0);
  return sum % 10 === 0;
}

const VERHOEFF_D = [
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
const VERHOEFF_P = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 5, 7, 6, 2, 8, 3, 0, 9, 4],
  [5, 8, 0, 3, 7, 9, 6, 1, 4, 2],
  [8, 9, 1, 6, 0, 4, 3, 5, 2, 7],
  [9, 4, 5, 3, 1, 2, 6, 8, 7, 0],
  [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
  [2, 7, 9, 3, 8, 0, 6, 4, 1, 5],
  [7, 0, 4, 6, 9, 1, 3, 2, 5, 8],
];

/** Verhoeff check, as used by Aadhaar. */
export function verhoeffValid(value: string): boolean {
  let c = 0;
  digits(value)
    .reverse()
    .forEach((digit, index) => {
      const permuted = VERHOEFF_P[index % 8]?.[digit] ?? 0;
      c = VERHOEFF_D[c]?.[permuted] ?? 0;
    });
  return c === 0;
}

/** Brazilian CPF: two mod-11 check digits. */
export function cpfValid(value: string): boolean {
  const d = digits(value);
  if (d.length !== 11 || new Set(d).size === 1) return false;
  const check = (length: number): number => {
    const sum = d
      .slice(0, length)
      .reduce((total, digit, index) => total + digit * (length + 1 - index), 0);
    const remainder = (sum * 10) % 11;
    return remainder === 10 ? 0 : remainder;
  };
  return check(9) === d[9] && check(10) === d[10];
}

/** German Steuer-ID: ISO 7064 Mod 11,10 check digit. */
export function steuerIdValid(value: string): boolean {
  const d = digits(value);
  if (d.length !== 11 || d[0] === 0) return false;
  let product = 10;
  for (const digit of d.slice(0, 10)) {
    let sum = (digit + product) % 10;
    if (sum === 0) sum = 10;
    product = (sum * 2) % 11;
  }
  const check = 11 - product === 10 ? 0 : 11 - product;
  return check === d[10];
}

/** French NIR: 13 digits followed by a key of 97 - (n mod 97). */
export function nirValid(value: string): boolean {
  const compact = value.replace(/\s/g, '');
  if (!/^\d{15}$/.test(compact)) return false;
  const base = BigInt(compact.slice(0, 13));
  return 97n - (base % 97n) === BigInt(compact.slice(13));
}

/** Singapore NRIC/FIN check letter for the S, T, F and G series. */
export function nricValid(value: string): boolean {
  const match = /^([STFG])(\d{7})([A-Z])$/.exec(value);
  if (!match) return false;
  const [, prefix = '', body = '', letter = ''] = match;
  const weights = [2, 7, 6, 5, 4, 3, 2];
  let sum = Array.from(body).reduce(
    (total, digit, index) => total + Number(digit) * (weights[index] ?? 0),
    0,
  );
  if (prefix === 'T' || prefix === 'G') sum += 4;
  const table =
    prefix === 'S' || prefix === 'T' ? 'JZIHGFEDCBA' : 'XWUTRQPNMLK';
  return table[sum % 11] === letter;
}

/** Chinese resident ID (GB 11643): ISO 7064 Mod 11-2 check character. */
export function chineseIdValid(value: string): boolean {
  if (!/^\d{17}[\dX]$/.test(value)) return false;
  const weights = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
  const sum = Array.from(value.slice(0, 17)).reduce(
    (total, digit, index) => total + Number(digit) * (weights[index] ?? 0),
    0,
  );
  return '10X98765432'[sum % 11] === value[17];
}

/** South African ID: plausible YYMMDD date plus a Luhn check digit. */
export function southAfricanIdValid(value: string): boolean {
  if (!/^\d{13}$/.test(value)) return false;
  const month = Number(value.slice(2, 4));
  const day = Number(value.slice(4, 6));
  return month >= 1 && month <= 12 && day >= 1 && day <= 31 && luhnValid(value);
}

/** US SSN: has no check digit, so this confirms the reserved advertising block. */
export function ssnInAdvertisingRange(value: string): boolean {
  return /^987-65-432\d$/.test(value);
}

/** GB NINO: has no check digit, so this confirms the format only. */
export function ninoFormatValid(value: string): boolean {
  return /^[A-Z]{2} \d{2} \d{2} \d{2} [A-D]$/.test(value);
}
