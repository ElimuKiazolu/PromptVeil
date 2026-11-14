/**
 * The forms of a masked real value the request safety net looks for: compact
 * forms (see compact.ts) that every common writing of the value contains.
 *
 * - PHONE: the national significant number. Every written form of a number
 *   ends with it ("07400 123456", "+44 7400 123456", "0044 7400 123456" all
 *   contain 7400123456), so a request carrying the number in any of them is
 *   caught. It is the E.164 normal form without its calling code.
 * - Every other type: the compact form of the value as written.
 *
 * Forms shorter than MIN_FORM_LENGTH are left out.
 */
import type { EntityType } from '../../shared/entities.ts';
import { CALLING_CODES } from './calling-codes.ts';
import { compactForm, MIN_FORM_LENGTH } from './compact.ts';

function nationalNumber(normalised: string): string {
  const digits = normalised.replace(/\D/gu, '');
  if (!normalised.startsWith('+')) return digits;
  // The calling codes are prefix-free: at most one matches.
  const code = CALLING_CODES.find((entry) => digits.startsWith(entry));
  return code === undefined ? digits : digits.slice(code.length);
}

export function netForms(
  type: EntityType,
  real: string,
  normalised: string,
): string[] {
  const form =
    type === 'PHONE' ? nationalNumber(normalised) : compactForm(real);
  return form.length >= MIN_FORM_LENGTH ? [form] : [];
}
