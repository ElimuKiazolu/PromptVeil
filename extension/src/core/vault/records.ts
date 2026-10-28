/** Shape checks for records read back from the database. */
import { isCountryCode } from '@/src/shared/country.ts';
import {
  isEntitySubtype,
  isEntityType,
  type EncryptedValue,
  type Mapping,
} from '@/src/shared/entities.ts';
import type { ConversationRecord } from './types.ts';

type Fields = Record<string, unknown>;

function isObject(value: unknown): value is Fields {
  return typeof value === 'object' && value !== null;
}

function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isStringOrNull(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function isEncryptedValue(value: unknown): value is EncryptedValue {
  return (
    isObject(value) &&
    value.iv instanceof Uint8Array &&
    value.ct instanceof ArrayBuffer
  );
}

const SOURCES: readonly unknown[] = ['rule', 'ner', 'custom', 'manual'];

export function isMappingRecord(value: unknown): value is Mapping {
  if (!isObject(value)) return false;
  const v = value;
  return (
    typeof v.id === 'string' &&
    typeof v.conversationId === 'string' &&
    isEntityType(v.type) &&
    (v.subtype === null || isEntitySubtype(v.subtype)) &&
    (v.country === null ||
      (typeof v.country === 'string' && isCountryCode(v.country))) &&
    isStringOrNull(v.locale) &&
    typeof v.realHash === 'string' &&
    isEncryptedValue(v.realEnc) &&
    typeof v.surrogate === 'string' &&
    typeof v.surrogateNorm === 'string' &&
    Array.isArray(v.variants) &&
    v.variants.every((variant) => typeof variant === 'string') &&
    isStringOrNull(v.parentId) &&
    SOURCES.includes(v.source) &&
    isNumber(v.confidence) &&
    isNumber(v.createdAt) &&
    isNumber(v.hitCount)
  );
}

const SITES: readonly unknown[] = ['chatgpt', 'gemini', 'claude'];
const STATUSES: readonly unknown[] = ['active', 'pending'];

export function isConversationRecord(
  value: unknown,
): value is ConversationRecord {
  if (!isObject(value)) return false;
  return (
    typeof value.id === 'string' &&
    SITES.includes(value.site) &&
    STATUSES.includes(value.status) &&
    isNumber(value.dateOffsetDays) &&
    isNumber(value.createdAt) &&
    isNumber(value.lastUsedAt) &&
    isNumber(value.mappingCount)
  );
}
