import { describe, expect, it } from 'vitest';
import {
  isDigits,
  isValidLuhn,
  isValidMod11_10,
  isValidMod11_2,
  isValidMod97_10,
  isValidVerhoeff,
  luhnCheckDigit,
  mod11_10CheckDigit,
  mod11_2CheckCharacter,
  mod23Letter,
  mod97,
  mod97_10CheckDigits,
  verhoeffCheckDigit,
  weightedMod11,
} from '@/src/core/detect/checksum.ts';

describe('isDigits', () => {
  it('accepts ASCII digits only', () => {
    expect(isDigits('0123456789')).toBe(true);
    expect(isDigits('')).toBe(false);
    expect(isDigits('12 34')).toBe(false);
    expect(isDigits('12-34')).toBe(false);
    // Arabic-Indic and full-width digits are not ASCII digits.
    expect(isDigits('١٢٣')).toBe(false);
    expect(isDigits('１２３')).toBe(false);
  });
});

describe('Luhn', () => {
  // Worked example from ISO/IEC 7812-1 annex B, as reproduced in most references.
  it('computes the check digit of the reference example', () => {
    expect(luhnCheckDigit('7992739871')).toBe(3);
    expect(isValidLuhn('79927398713')).toBe(true);
  });

  it('accepts published test card numbers', () => {
    // Stripe / Adyen test cards.
    for (const card of [
      '4242424242424242',
      '4111111111111111',
      '5555555555554444',
      '378282246310005',
      '6011111111111117',
    ]) {
      expect(isValidLuhn(card)).toBe(true);
    }
  });

  it('accepts the fixture CA SIN and ZA ID (published examples)', () => {
    expect(isValidLuhn('046454286')).toBe(true);
    expect(isValidLuhn('9807055009087')).toBe(true);
  });

  it('rejects any single changed digit and adjacent swaps', () => {
    expect(isValidLuhn('79927398710')).toBe(false);
    expect(isValidLuhn('79927398714')).toBe(false);
    expect(isValidLuhn('4242424242424241')).toBe(false);
    expect(isValidLuhn('97927398713')).toBe(false);
  });

  it('is unaffected by leading zeros', () => {
    expect(isValidLuhn('0079927398713')).toBe(true);
    expect(luhnCheckDigit('007992739871')).toBe(3);
  });

  it('rejects empty, too short and non-digit input', () => {
    expect(isValidLuhn('')).toBe(false);
    expect(isValidLuhn('0')).toBe(false);
    expect(isValidLuhn('7992 7398 713')).toBe(false);
    expect(isValidLuhn('7992739871a')).toBe(false);
    expect(luhnCheckDigit('')).toBeNull();
    expect(luhnCheckDigit('12a')).toBeNull();
  });

  it('round-trips: payload + computed check digit validates', () => {
    for (const payload of ['1', '12', '424242424242424', '0000000000']) {
      const check = luhnCheckDigit(payload);
      expect(check).not.toBeNull();
      expect(isValidLuhn(`${payload}${String(check)}`)).toBe(true);
    }
  });
});

describe('Verhoeff', () => {
  // Example from Verhoeff (1969) as used in the algorithm's standard description.
  it('computes the check digit of the reference example', () => {
    expect(verhoeffCheckDigit('236')).toBe(3);
    expect(isValidVerhoeff('2363')).toBe(true);
  });

  it('accepts the UIDAI test Aadhaar number from the fixtures', () => {
    expect(isValidVerhoeff('999999990019')).toBe(true);
  });

  it('detects single-digit errors and adjacent transpositions', () => {
    expect(isValidVerhoeff('2364')).toBe(false);
    expect(isValidVerhoeff('3263')).toBe(false);
    expect(isValidVerhoeff('999999990018')).toBe(false);
    expect(isValidVerhoeff('999999999019')).toBe(false);
  });

  it('treats leading zeros as significant (the permutation depends on position)', () => {
    expect(isValidVerhoeff('02363')).toBe(false);
    const check = verhoeffCheckDigit('0236');
    expect(check).not.toBeNull();
    expect(isValidVerhoeff(`0236${String(check)}`)).toBe(true);
  });

  it('rejects empty, too short and non-digit input', () => {
    expect(isValidVerhoeff('')).toBe(false);
    expect(isValidVerhoeff('0')).toBe(false);
    expect(isValidVerhoeff('236 3')).toBe(false);
    expect(verhoeffCheckDigit('')).toBeNull();
    expect(verhoeffCheckDigit('2x6')).toBeNull();
  });

  it('round-trips', () => {
    for (const payload of ['1', '9999999900', '12345678901']) {
      const check = verhoeffCheckDigit(payload);
      expect(isValidVerhoeff(`${payload}${String(check)}`)).toBe(true);
    }
  });
});

describe('ISO 7064 MOD 11-2', () => {
  // ISO/IEC 7064 worked examples for the pure MOD 11-2 system.
  it('computes the standard examples', () => {
    expect(mod11_2CheckCharacter('0794')).toBe('0');
    expect(mod11_2CheckCharacter('079')).toBe('X');
    expect(isValidMod11_2('07940')).toBe(true);
    expect(isValidMod11_2('079X')).toBe(true);
  });

  it('matches the ORCID documentation example 0000-0002-1825-0097', () => {
    expect(mod11_2CheckCharacter('000000021825009')).toBe('7');
    expect(isValidMod11_2('0000000218250097')).toBe(true);
  });

  it('matches the GB 11643-1999 citizen ID example', () => {
    expect(isValidMod11_2('11010519491231002X')).toBe(true);
  });

  it('rejects wrong check characters, lower-case x and bad input', () => {
    expect(isValidMod11_2('07941')).toBe(false);
    expect(isValidMod11_2('079x')).toBe(false);
    expect(isValidMod11_2('110105194912310021')).toBe(false);
    expect(isValidMod11_2('X')).toBe(false);
    expect(isValidMod11_2('')).toBe(false);
    expect(isValidMod11_2('07-940')).toBe(false);
    expect(mod11_2CheckCharacter('')).toBeNull();
    expect(mod11_2CheckCharacter('07a')).toBeNull();
  });

  it('leading zeros do not change the check character', () => {
    expect(mod11_2CheckCharacter('00794')).toBe('0');
  });
});

describe('ISO 7064 MOD 11,10', () => {
  // ISO/IEC 7064 worked example for the hybrid MOD 11,10 system.
  it('computes the standard example', () => {
    expect(mod11_10CheckDigit('0794')).toBe(5);
    expect(isValidMod11_10('07945')).toBe(true);
  });

  it('accepts the published German tax ID examples', () => {
    // A widely published example and the fixture's published example.
    expect(isValidMod11_10('86095742719')).toBe(true);
    expect(isValidMod11_10('65929970489')).toBe(true);
  });

  it('accepts a commonly published Croatian OIB example (same algorithm)', () => {
    expect(isValidMod11_10('69435151530')).toBe(true);
  });

  it('rejects changed digits and bad input', () => {
    expect(isValidMod11_10('07946')).toBe(false);
    expect(isValidMod11_10('86095742718')).toBe(false);
    expect(isValidMod11_10('')).toBe(false);
    expect(isValidMod11_10('5')).toBe(false);
    expect(isValidMod11_10('8609 5742 719')).toBe(false);
    expect(mod11_10CheckDigit('')).toBeNull();
    expect(mod11_10CheckDigit('0x94')).toBeNull();
  });

  it('round-trips', () => {
    for (const payload of ['0', '1234567890', '0000000000']) {
      const check = mod11_10CheckDigit(payload);
      expect(isValidMod11_10(`${payload}${String(check)}`)).toBe(true);
    }
  });
});

describe('ISO 7064 MOD 97-10 / ISO 13616', () => {
  // ISO/IEC 7064 worked example for MOD 97-10.
  it('computes the standard example', () => {
    expect(mod97_10CheckDigits('794')).toBe('44');
    expect(isValidMod97_10('79444')).toBe(true);
  });

  it('pads single-digit check values', () => {
    // 98 − (payload·100 mod 97) below 10 must still be two digits.
    const payload = '0000000096';
    const check = mod97_10CheckDigits(payload);
    expect(check).toHaveLength(2);
    expect(isValidMod97_10(`${payload}${check ?? ''}`)).toBe(true);
  });

  it('converts letters as ISO 13616 (A = 10 … Z = 35)', () => {
    // GB82 WEST 1234 5698 7654 32, the IBAN registry's GB example, rearranged.
    expect(mod97('WEST12345698765432GB82')).toBe(1);
    expect(mod97('WEST12345698765432GB83')).not.toBe(1);
  });

  it('handles strings far longer than a safe integer without overflow', () => {
    const long = '1234567890'.repeat(100);
    const expected = Number(BigInt(long) % 97n);
    expect(mod97(long)).toBe(expected);
    const check = mod97_10CheckDigits(long);
    expect(isValidMod97_10(`${long}${check ?? ''}`)).toBe(true);
  });

  it('is unaffected by leading zeros', () => {
    expect(isValidMod97_10('00079444')).toBe(true);
  });

  it('rejects empty, lower-case and punctuated input', () => {
    expect(mod97('')).toBeNull();
    expect(mod97('west')).toBeNull();
    expect(mod97('12 34')).toBeNull();
    expect(isValidMod97_10('')).toBe(false);
    expect(isValidMod97_10('1')).toBe(false);
    expect(isValidMod97_10('79445')).toBe(false);
    expect(isValidMod97_10('AB444')).toBe(false);
    expect(mod97_10CheckDigits('')).toBeNull();
  });
});

describe('weightedMod11', () => {
  const descending = [10, 9, 8, 7, 6, 5, 4, 3, 2];

  it('NHS number 943 476 5919 (NHS Digital example): 11 − r = 9', () => {
    expect(weightedMod11('943476591', descending)).toBe(2);
  });

  it('ISBN 0-306-40615-2 (ISBN-10 reference example): 11 − r = 2', () => {
    expect(weightedMod11('030640615', descending)).toBe(9);
  });

  it('leading zeros contribute nothing', () => {
    expect(weightedMod11('000000001', descending)).toBe(2);
  });

  it('rejects a weight count mismatch, empty and non-digit input', () => {
    expect(weightedMod11('94347659', descending)).toBeNull();
    expect(weightedMod11('', [])).toBeNull();
    expect(weightedMod11('94347659a', descending)).toBeNull();
  });
});

describe('mod23Letter (Spanish DNI / NIE)', () => {
  it('matches the Ministry of the Interior examples', () => {
    expect(mod23Letter('12345678')).toBe('Z');
    expect(mod23Letter('00000000')).toBe('T');
    // NIE X1234567L: X is replaced by 0.
    expect(mod23Letter('01234567')).toBe('L');
  });

  it('covers every remainder with a distinct letter', () => {
    const letters = new Set<string>();
    for (let n = 0; n < 23; n += 1)
      letters.add(mod23Letter(n.toString()) ?? '');
    expect(letters.size).toBe(23);
  });

  it('rejects empty and non-digit input', () => {
    expect(mod23Letter('')).toBeNull();
    expect(mod23Letter('1234567X')).toBeNull();
  });
});
