/**
 * IBAN stand-ins (TR-S2): the same country and length, valid under
 * MOD 97-10. The BBAN keeps its structure as written: every digit becomes a
 * random digit and every letter a random letter, so bank and branch codes
 * keep their length and character kind (e.g. GB's four-letter bank code).
 * No range of IBANs is reserved for examples or tests, so all are random.
 */
import { mod97 } from '../detect/checksum.ts';
import { normaliseIban } from '../detect/validators/iban.ts';
import { applyLayout } from './layout.ts';
import { DIGITS, UPPER } from './rng.ts';
import type { Generator } from './types.ts';

export const ibanStandIn: Generator = ({ request, rng }) => {
  const real = normaliseIban(request.value);
  const country = real.slice(0, 2);
  let bban = '';
  for (const char of real.slice(4)) {
    bban += char >= '0' && char <= '9' ? rng.char(DIGITS) : rng.char(UPPER);
  }
  const remainder = mod97(`${bban}${country}00`);
  if (remainder === null) return null;
  const check = (98 - remainder).toString().padStart(2, '0');
  const iban = `${country}${check}${bban}`;
  if (iban === real) return null;
  return { value: applyLayout(request.value, iban), reserved: false };
};
