import type { Rule } from './types.ts';
import { CARD_RULE } from './card.ts';
import { BITCOIN_RULE, ETHEREUM_RULE } from './crypto.ts';
import { DOB_RULE } from './dob.ts';
import { EMAIL_RULE } from './email.ts';
import { IBAN_RULE } from './iban.ts';
import { IP_RULE } from './ip.ts';
import { PHONE_RULE } from './phone.ts';
import { SECRET_RULES } from './secret.ts';

/** The global rules (TR §4.2: P0, then IP, CRYPTO and DOB), in tie-break order. */
export const GLOBAL_RULES: readonly Rule[] = [
  EMAIL_RULE,
  PHONE_RULE,
  CARD_RULE,
  IBAN_RULE,
  ...SECRET_RULES,
  IP_RULE,
  BITCOIN_RULE,
  ETHEREUM_RULE,
  DOB_RULE,
];
