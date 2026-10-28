/**
 * Spain pack: DNI and NIE (ES_DNI).
 *
 * DNI (Ministerio del Interior): eight digits and a check letter, the
 * number modulo 23 looked up in TRWAGMYFPDXBNJZSQVHLCKE. NIE (foreigners):
 * X, Y or Z, seven digits and a check letter, with X = 0, Y = 1, Z = 2 put in
 * front of the digits before the same modulo 23. Written plain, or with a
 * hyphen or space before the letter (12345678-Z, X-1234567-L).
 *
 * NIE stays under ES_DNI, as TR §4.2 defines it: the same check algorithm
 * and the same holder data (a personal identity and tax number); the stand-in
 * keeps the written form, so an NIE stays an NIE.
 */
import { mod23Letter } from '../../checksum.ts';
import { ID_REFERENCE_BEFORE } from '../negative.ts';
import type { Span } from '../../text.ts';
import { INVALID, finding, type Rule } from '../types.ts';
import type { CountryPack } from './index.ts';

const DNI = /^(\d{8})[ -]?([A-Za-z])$/u;
const NIE = /^([XYZxyz])-?(\d{7})[ -]?([A-Za-z])$/u;
const NIE_PREFIX: Readonly<Record<string, string>> = { X: '0', Y: '1', Z: '2' };

/** The digits the letter is computed from, and the written letter. */
function readDocument(
  value: string,
): { digits: string; letter: string } | null {
  const dni = DNI.exec(value);
  if (dni !== null)
    return { digits: dni[1] ?? '', letter: (dni[2] ?? '').toUpperCase() };
  const nie = NIE.exec(value);
  if (nie === null) return null;
  const prefix = NIE_PREFIX[(nie[1] ?? '').toUpperCase()] ?? '';
  return {
    digits: `${prefix}${nie[2] ?? ''}`,
    letter: (nie[3] ?? '').toUpperCase(),
  };
}

export function isValidDni(value: string): boolean {
  const read = readDocument(value);
  return read !== null && mod23Letter(read.digits) === read.letter;
}

const DNI_CANDIDATE =
  /(?<![\p{L}\p{N}_])(?<!\d[ .,-])(?:\d{8}[ -]?[A-Za-z]|[XYZxyz]-?\d{7}[ -]?[A-Za-z])(?![\p{L}\p{N}_])/gu;

function* findDnis(text: string): Generator<Span> {
  for (const match of text.matchAll(DNI_CANDIDATE)) {
    yield { start: match.index, end: match.index + match[0].length };
  }
}

/** Check letter for the eight digits (an NIE's prefix already replaced). */
function dniCheckLetter(payload: string): string | null {
  return mod23Letter(payload);
}

export const ES_DNI_RULE: Rule = {
  id: 'es.dni',
  type: 'NATIONAL_ID',
  subtype: 'ES_DNI',
  country: 'ES',
  find: findDnis,
  validate: (value) =>
    isValidDni(value) ? finding(ES_DNI_RULE, 'checksum') : INVALID,
  context: {
    words: [
      'dni',
      'd.n.i.',
      'nie',
      'nif',
      'documento nacional de identidad',
      'número de identidad de extranjero',
      'numero de identidad de extranjero',
      'número de identificación fiscal',
      'id card',
    ],
    before: 40,
    after: 16,
  },
  contextRequired: false,
  negativeContext: [ID_REFERENCE_BEFORE],
  confidence: { validated: 1, context: 1, none: 1 },
};

export const ES_PACK: CountryPack = {
  country: 'ES',
  rules: [ES_DNI_RULE],
  standIns: {
    ES_DNI: {
      formats: [
        '########A',
        '########-A',
        '######## A',
        'X#######A',
        'X-#######-A',
      ],
      checksum: 'mod23-letter',
      checkCharacters: dniCheckLetter,
      isValid: isValidDni,
      avoid: ['keep DNI vs NIE (and the NIE prefix letter) as written'],
    },
  },
};
