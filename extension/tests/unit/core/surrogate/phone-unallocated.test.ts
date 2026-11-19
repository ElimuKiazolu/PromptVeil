import { sha256 } from '@noble/hashes/sha2.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import {
  getCountries,
  getExampleNumber,
  parsePhoneNumberFromString,
} from 'libphonenumber-js/max';
import examples from 'libphonenumber-js/mobile/examples';
import { describe, expect, it } from 'vitest';
import { normaliseReal } from '@/src/core/detect/normal-form.ts';
import {
  generateStandIn,
  isWellFormedStandIn,
  RESERVED_ATTEMPTS,
} from '@/src/core/surrogate/engine.ts';
import { isReservedPhone } from '@/src/core/surrogate/phone.ts';
import type { StandInRequest } from '@/src/core/surrogate/types.ts';
import { isCountryCode, type CountryCode } from '@/src/shared/country.ts';

// Every region's example mobile number from libphonenumber's metadata (the
// library's published examples), written in international and national
// form. Stand-ins after the fiction ranges must be unallocated: possible
// for the calling code but valid in none of its regions. This test is the
// check on a libphonenumber-js upgrade: a range that becomes allocated
// makes the shipped generator refuse it, and this test shows it.
const seed = (n: number) => sha256(utf8ToBytes(`unallocated ${n.toString()}`));

function request(country: CountryCode, value: string): StandInRequest {
  return {
    type: 'PHONE',
    subtype: null,
    country,
    value,
    normalised: normaliseReal('PHONE', null, country, value),
    dateOffsetDays: 40,
    number: 1,
    now: 0,
  };
}

describe('unallocated phone stand-ins', () => {
  it('exist for every region and are valid nowhere', () => {
    let regions = 0;
    for (const region of getCountries()) {
      const example = getExampleNumber(region, examples);
      // AC and TA are SH in our country list.
      if (example === undefined || !isCountryCode(region)) continue;
      regions += 1;
      for (const written of [
        example.formatInternational(),
        example.formatNational(),
      ]) {
        const real = request(region, written);
        for (let n = 0; n < 3; n += 1) {
          const standIn = generateStandIn(real, seed(n), RESERVED_ATTEMPTS + n);
          if (standIn === null) {
            throw new Error(`no stand-in for ${region} ${written}`);
          }
          expect(isWellFormedStandIn(real, standIn.value), standIn.value).toBe(
            true,
          );
          const parsed = parsePhoneNumberFromString(
            `+${example.countryCallingCode}${
              parsePhoneNumberFromString(standIn.value, region)
                ?.nationalNumber ?? ''
            }`,
          );
          expect(parsed?.isPossible(), `${region} ${standIn.value}`).toBe(true);
          expect(parsed?.isValid(), `${region} ${standIn.value}`).toBe(false);
          expect(isReservedPhone(standIn.value, region)).toBe(false);
        }
      }
    }
    expect(regions).toBeGreaterThan(235);
  }, 120_000);
});
