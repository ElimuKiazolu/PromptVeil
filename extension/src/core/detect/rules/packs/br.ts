/**
 * Brazil pack: CPF (BR_CPF), Cadastro de Pessoas Físicas.
 *
 * Eleven digits written 000.000.000-00 or plain. The last two are check
 * digits (Receita Federal method): the first over the nine base digits with
 * weights 10 down to 2, the second over the ten digits with weights 11 down
 * to 2; each is 11 minus the sum modulo 11, or 0 when the remainder is under
 * 2. Numbers made of one repeated digit pass the check but are never issued,
 * so they are rejected.
 */
import { ID_REFERENCE_BEFORE } from '../negative.ts';
import type { Span } from '../../text.ts';
import { INVALID, finding, type Rule } from '../types.ts';
import { isRepeatedDigit } from './common.ts';
import type { CountryPack } from './index.ts';

const FORMATTED = /^(\d{3})\.(\d{3})\.(\d{3})-(\d{2})$/u;

function cpfDigits(value: string): string | null {
  if (/^\d{11}$/u.test(value)) return value;
  const parts = FORMATTED.exec(value);
  return parts === null ? null : parts.slice(1).join('');
}

function checkDigit(digits: string): number {
  let sum = 0;
  for (let i = 0; i < digits.length; i += 1) {
    sum += Number(digits.charAt(i)) * (digits.length + 1 - i);
  }
  const remainder = sum % 11;
  return remainder < 2 ? 0 : 11 - remainder;
}

/** The two check digits for nine base digits, or null. */
export function cpfCheckDigits(payload: string): string | null {
  if (!/^\d{9}$/u.test(payload)) return null;
  const first = checkDigit(payload);
  const second = checkDigit(`${payload}${first.toString()}`);
  return `${first.toString()}${second.toString()}`;
}

export function isValidCpf(value: string): boolean {
  const digits = cpfDigits(value);
  if (digits === null || isRepeatedDigit(digits)) return false;
  return cpfCheckDigits(digits.slice(0, 9)) === digits.slice(9);
}

/** 000.000.000-00 or eleven plain digits, not part of a longer number. */
const CPF_CANDIDATE =
  /(?<![\p{L}\p{N}_])(?<!\d[ .,-])(?:\d{3}\.\d{3}\.\d{3}-\d{2}|\d{11})(?![ .,-]?\d)(?![\p{L}\p{N}_])/gu;

function* findCpfs(text: string): Generator<Span> {
  for (const match of text.matchAll(CPF_CANDIDATE)) {
    yield { start: match.index, end: match.index + match[0].length };
  }
}

export const BR_CPF_RULE: Rule = {
  id: 'br.cpf',
  type: 'NATIONAL_ID',
  subtype: 'BR_CPF',
  country: 'BR',
  find: findCpfs,
  validate: (value) =>
    isValidCpf(value) ? finding(BR_CPF_RULE, 'checksum') : INVALID,
  context: {
    words: [
      'cpf',
      'c.p.f.',
      'cadastro de pessoas físicas',
      'cadastro de pessoa física',
      'cadastro de pessoas fisicas',
      'cadastro de pessoa fisica',
    ],
    before: 40,
    after: 16,
  },
  contextRequired: false,
  negativeContext: [ID_REFERENCE_BEFORE],
  confidence: { validated: 1, context: 1, none: 1 },
};

export const BR_PACK: CountryPack = {
  country: 'BR',
  rules: [BR_CPF_RULE],
  standIns: {
    BR_CPF: {
      formats: ['###.###.###-##', '###########'],
      checksum: 'weighted-mod11',
      checkCharacters: cpfCheckDigits,
      isValid: isValidCpf,
      avoid: ['one digit repeated (000.000.000-00 … 999.999.999-99)'],
    },
  },
};
