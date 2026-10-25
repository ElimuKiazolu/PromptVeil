/**
 * India pack: Aadhaar (IN_AADHAAR), Aadhaar Virtual ID (IN_VID) and PAN
 * (IN_PAN).
 *
 * Aadhaar (UIDAI): 12 digits, written 4-4-4 or plain; the first digit is 2–9
 * and the last a Verhoeff check digit. Numbers are random and never
 * palindromes (UIDAI numbering scheme, as applied by python-stdnum
 * in_.aadhaar). Twelve plain digits count only with a context word.
 *
 * Virtual ID (UIDAI circular of 11 January 2018 and VID FAQ): a revocable
 * 16-digit number mapped to an Aadhaar number, last digit Verhoeff, not
 * starting with 0 or 1, not a palindrome (python-stdnum in_.vid). Sixteen
 * digits are also the shape of most card numbers, so a VID always needs a
 * context word.
 *
 * PAN (Income Tax Department): five letters, four digits, one letter. The
 * fourth letter is the holder type (P person, C company, H Hindu undivided
 * family, F firm, A association of persons, T trust, B body of individuals,
 * L local authority, J artificial juridical person, G government); the
 * serial 0000 is never issued. The last letter is a check character whose
 * algorithm is not published, so it is not checked.
 */
import { isValidVerhoeff, verhoeffCheckDigit } from '../../checksum.ts';
import { ID_REFERENCE_BEFORE } from '../negative.ts';
import type { Span } from '../../text.ts';
import { INVALID, finding, type Rule } from '../types.ts';
import { digitGroupScanner, groupedDigits } from './common.ts';
import type { CountryPack } from './index.ts';

const AADHAAR_GROUPS = [4, 4, 4] as const;
const VID_GROUPS = [4, 4, 4, 4] as const;

/** True when the digits read the same backwards. */
export function isPalindrome(digits: string): boolean {
  for (let i = 0, j = digits.length - 1; i < j; i += 1, j -= 1) {
    if (digits.charAt(i) !== digits.charAt(j)) return false;
  }
  return true;
}

function isVerhoeffNumber(digits: string): boolean {
  return (
    /^[2-9]/u.test(digits) && !isPalindrome(digits) && isValidVerhoeff(digits)
  );
}

export function isValidAadhaar(value: string): boolean {
  const read = groupedDigits(value, AADHAAR_GROUPS);
  return read !== null && isVerhoeffNumber(read.digits);
}

export function isValidVid(value: string): boolean {
  const read = groupedDigits(value, VID_GROUPS);
  return read !== null && isVerhoeffNumber(read.digits);
}

function verhoeffCharacter(payload: string): string | null {
  const check = verhoeffCheckDigit(payload);
  return check === null ? null : check.toString();
}

const AADHAAR_CONTEXT = [
  'aadhaar',
  'aadhar',
  'aadhaar number',
  'aadhaar no',
  'uid',
  'uidai',
  'आधार',
  'आधार संख्या',
  'आधार नंबर',
];

export const IN_AADHAAR_RULE: Rule = {
  id: 'in.aadhaar',
  type: 'NATIONAL_ID',
  subtype: 'IN_AADHAAR',
  country: 'IN',
  find: digitGroupScanner(AADHAAR_GROUPS),
  validate(value, env) {
    if (!isValidAadhaar(value)) return INVALID;
    const plain = groupedDigits(value, AADHAAR_GROUPS)?.plain ?? true;
    if (plain && !env.hasContext) return INVALID;
    return finding(IN_AADHAAR_RULE, 'checksum');
  },
  context: { words: AADHAAR_CONTEXT, before: 40, after: 16 },
  contextRequired: false,
  negativeContext: [ID_REFERENCE_BEFORE],
  confidence: { validated: 1, context: 1, none: 1 },
};

export const IN_VID_RULE: Rule = {
  id: 'in.vid',
  type: 'NATIONAL_ID',
  subtype: 'IN_VID',
  country: 'IN',
  find: digitGroupScanner(VID_GROUPS),
  validate: (value) =>
    isValidVid(value) ? finding(IN_VID_RULE, 'checksum') : INVALID,
  context: {
    words: [
      'vid',
      'virtual id',
      'virtual id number',
      'aadhaar vid',
      'वर्चुअल आईडी',
    ],
    before: 40,
    after: 16,
  },
  contextRequired: true,
  negativeContext: [ID_REFERENCE_BEFORE],
  confidence: { validated: 1, context: 1, none: 1 },
};

const PAN_HOLDER_TYPES = 'PCHFATBLJG';
const PAN_FORMAT = /^[A-Z]{3}([A-Z])[A-Z](\d{4})[A-Z]$/u;

export function isValidPan(value: string): boolean {
  const parts = PAN_FORMAT.exec(value);
  if (parts === null) return false;
  const [, holder = '', serial = ''] = parts;
  return PAN_HOLDER_TYPES.includes(holder) && serial !== '0000';
}

/** Upper case only, as issued and printed. */
const PAN_CANDIDATE =
  /(?<![\p{L}\p{N}_])[A-Z]{3}[PCHFATBLJG][A-Z]\d{4}[A-Z](?![\p{L}\p{N}_])/gu;

function* findPans(text: string): Generator<Span> {
  for (const match of text.matchAll(PAN_CANDIDATE)) {
    yield { start: match.index, end: match.index + match[0].length };
  }
}

export const IN_PAN_RULE: Rule = {
  id: 'in.pan',
  type: 'NATIONAL_ID',
  subtype: 'IN_PAN',
  country: 'IN',
  find: findPans,
  validate: (value) =>
    isValidPan(value) ? finding(IN_PAN_RULE, 'structural') : INVALID,
  context: {
    words: [
      'pan',
      'pan card',
      'pan number',
      'pan no',
      'permanent account number',
      'पैन',
      'पैन कार्ड',
      'स्थायी खाता संख्या',
    ],
    before: 40,
    after: 16,
  },
  contextRequired: false,
  negativeContext: [ID_REFERENCE_BEFORE],
  confidence: { validated: 0.95, context: 0.95, none: 0.85 },
};

export const IN_PACK: CountryPack = {
  country: 'IN',
  rules: [IN_AADHAAR_RULE, IN_VID_RULE, IN_PAN_RULE],
  standIns: {
    IN_AADHAAR: {
      formats: ['#### #### ####', '####-####-####', '############'],
      checksum: 'verhoeff',
      checkCharacters: verhoeffCharacter,
      isValid: isValidAadhaar,
      avoid: ['first digit 0 or 1', 'palindromes'],
    },
    IN_VID: {
      formats: ['#### #### #### ####', '################'],
      checksum: 'verhoeff',
      checkCharacters: verhoeffCharacter,
      isValid: isValidVid,
      avoid: ['first digit 0 or 1', 'palindromes'],
    },
    IN_PAN: {
      formats: ['AAAAA####A'],
      checksum: null,
      checkCharacters: null,
      isValid: isValidPan,
      avoid: [
        'fourth letter other than P, C, H, F, A, T, B, L, J, G (keep the real one)',
        'serial 0000',
      ],
    },
  },
};
