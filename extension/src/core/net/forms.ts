/**
 * The forms of a masked real value the request safety net looks for: compact
 * forms (see compact.ts) that every common writing of the value contains.
 *
 * - PHONE: the national significant number. Every written form of a number
 *   ends with it ("07400 123456", "+44 7400 123456", "0044 7400 123456" all
 *   contain 7400123456), so a request carrying the number in any of them is
 *   caught. It is the E.164 normal form without its calling code.
 * - IP: the compact forms of the address as written, in its normal form and,
 *   for IPv6, written out in full, so a request that writes the address
 *   another way is caught too.
 * - Every other type: the compact form of the value as written.
 *
 * Forms shorter than MIN_FORM_LENGTH are left out.
 */
import type { EntityType } from '../../shared/entities.ts';
import { CALLING_CODES } from './calling-codes.ts';
import { compactForm, MIN_FORM_LENGTH } from './compact.ts';
import { expandIpv6, parseIpv6 } from '../detect/validators/ip.ts';

function nationalNumber(normalised: string): string {
  const digits = normalised.replace(/\D/gu, '');
  if (!normalised.startsWith('+')) return digits;
  // The calling codes are prefix-free: at most one matches.
  const code = CALLING_CODES.find((entry) => digits.startsWith(entry));
  return code === undefined ? digits : digits.slice(code.length);
}

/** The IP address's writings that a request could carry. */
function ipForms(real: string, normalised: string): string[] {
  const forms = [real, normalised];
  const v6 = normalised.includes(':') ? parseIpv6(normalised) : null;
  if (v6 !== null) forms.push(expandIpv6(v6));
  return forms.map(compactForm);
}

export function netForms(
  type: EntityType,
  real: string,
  normalised: string,
): string[] {
  const forms =
    type === 'PHONE'
      ? [nationalNumber(normalised)]
      : type === 'IP'
        ? ipForms(real, normalised)
        : [compactForm(real)];
  return [...new Set(forms)].filter((form) => form.length >= MIN_FORM_LENGTH);
}
