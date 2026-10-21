/**
 * Entity, detection and vault mapping types shared by the core pipeline, the
 * background and the UI. Pure types and constants, usable from src/core.
 */
import type { CountryCode } from './country.ts';

export const ENTITY_TYPES = [
  'PERSON',
  'ORG',
  'ADDRESS',
  'EMAIL',
  'PHONE',
  'CARD',
  'BANK',
  'NATIONAL_ID',
  'SECRET',
  'IP',
  'CRYPTO',
  'DOB',
  'DATE',
  'PASSPORT',
  'POSTCODE',
  'CUSTOM',
] as const;

export type EntityType = (typeof ENTITY_TYPES)[number];

/** Country ID formats (P0). Country formats are subtypes, never new entity types. */
export type NationalIdSubtype =
  | 'US_SSN'
  | 'UK_NINO'
  | 'UK_NHS'
  | 'CA_SIN'
  | 'BR_CPF'
  | 'IN_AADHAAR'
  | 'IN_PAN'
  | 'CN_RIC'
  | 'SG_NRIC'
  | 'ZA_ID'
  | 'ES_DNI'
  | 'IT_CF'
  | 'FR_NIR'
  | 'DE_TAXID';

export type BankSubtype =
  'IBAN' | 'SWIFT_BIC' | 'US_ABA' | 'UK_SORTCODE' | 'IN_IFSC' | 'IN_UPI';

/** The exact format of a detected value; null where a type has only one. */
export type EntitySubtype = NationalIdSubtype | BankSubtype;

export type DetectionSource = 'rule' | 'ner' | 'custom' | 'manual';

/**
 * confirmed: masked automatically. possible: the kind of value is unclear
 * (e.g. which country's ID it is, or whether it is personal data at all);
 * shown in the Review panel (P9) and never masked automatically.
 */
export type DetectionStatus = 'confirmed' | 'possible';

/** Another reading of the same text: a different format or country. */
export interface DetectionAlternative {
  subtype: EntitySubtype | null;
  country: CountryCode | null;
  /** 0–1. */
  confidence: number;
}

/** One item found in a prompt. Offsets are UTF-16 code units into the prompt. */
export interface Detection {
  type: EntityType;
  subtype: EntitySubtype | null;
  /** Country the format belongs to; null for global types. */
  country: CountryCode | null;
  /** Index of the first code unit. */
  start: number;
  /** Index just past the last code unit. */
  end: number;
  /** The text between start and end, exactly as written. */
  value: string;
  /** 0–1. */
  confidence: number;
  /** True when the value passed its checksum or structural validator. */
  validated: boolean;
  source: DetectionSource;
  status: DetectionStatus;
  /** Other readings of an ambiguous value, most likely first; empty otherwise. */
  alternatives: readonly DetectionAlternative[];
}

/** AES-GCM ciphertext of a real value. */
export interface EncryptedValue {
  iv: Uint8Array<ArrayBuffer>;
  ct: ArrayBuffer;
}

/** A vault record: one real value and the stand-in it was given in a conversation. */
export interface Mapping {
  /** UUID. */
  id: string;
  conversationId: string;
  type: EntityType;
  subtype: EntitySubtype | null;
  country: CountryCode | null;
  /** Locale used for the stand-in, e.g. `pt_BR`. */
  locale: string | null;
  /** Base64 HMAC of type + subtype + normalised real value; finds a mapping without decrypting. */
  realHash: string;
  realEnc: EncryptedValue;
  /** The stand-in exactly as sent (it was sent to the AI anyway). */
  surrogate: string;
  /** Normalised stand-in for matching. */
  surrogateNorm: string;
  /** Extra stand-in-side forms to restore (first name, digits only, ...). Never real-side text. */
  variants: string[];
  /** Links name parts or an email to its PERSON mapping. */
  parentId: string | null;
  source: DetectionSource;
  /** 0–1. */
  confidence: number;
  /** Epoch ms. */
  createdAt: number;
  /** Times reused in the conversation. */
  hitCount: number;
}
