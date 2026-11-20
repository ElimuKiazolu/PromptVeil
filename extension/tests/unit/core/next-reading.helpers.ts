/**
 * Numbers with two checksum readings, made in memory (fictional): an
 * 18-digit Chinese resident ID of Gansu (province 62) that also passes the
 * Luhn check (so it reads as a UnionPay card), a South African ID that reads
 * as a 13-digit Visa number, and a 13-digit Visa number with no ID reading.
 */
function luhnValid(digits: string): boolean {
  let sum = 0;
  for (const [i, char] of Array.from(digits).reverse().entries()) {
    let digit = Number(char);
    if (i % 2 === 1) digit = digit * 2 > 9 ? digit * 2 - 9 : digit * 2;
    sum += digit;
  }
  return sum % 10 === 0;
}

function luhnComplete(payload: string): string {
  for (let check = 0; check < 10; check += 1) {
    if (luhnValid(payload + check.toString()))
      return payload + check.toString();
  }
  throw new Error('no Luhn digit');
}

const RIC_WEIGHTS = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];

/** A Gansu resident ID (born 14 March 1985) that is also Luhn-valid. */
export function gansuIdAlsoLuhn(): string {
  for (let sequence = 0; sequence < 1000; sequence += 1) {
    const body = `62010219850314${sequence.toString().padStart(3, '0')}`;
    const sum = Array.from(body).reduce(
      (total, char, i) => total + Number(char) * (RIC_WEIGHTS[i] ?? 0),
      0,
    );
    const check = (12 - (sum % 11)) % 11;
    if (check === 10) continue;
    const id = body + check.toString();
    if (luhnValid(id)) return id;
  }
  throw new Error('no such ID');
}

/** A South African ID (born 12 March 1945): 13 digits starting with 4. */
export function southAfricanIdAlsoVisa(): string {
  return luhnComplete('450312500908');
}

/** A 13-digit Visa number whose digits are no valid ID (month 13). */
export function visa13WithoutId(): string {
  return luhnComplete('491301234567');
}
