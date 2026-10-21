import type { Rule } from './types.ts';
import { CARD_RULE } from './card.ts';
import { EMAIL_RULE } from './email.ts';
import { IBAN_RULE } from './iban.ts';
import { PHONE_RULE } from './phone.ts';
import { SECRET_RULES } from './secret.ts';

/** The P0 global rules (TR §4.2), in tie-break order. */
export const GLOBAL_RULES: readonly Rule[] = [
  EMAIL_RULE,
  PHONE_RULE,
  CARD_RULE,
  IBAN_RULE,
  ...SECRET_RULES,
];
