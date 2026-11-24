/**
 * Texts of the notice shown when PromptVeil stops a write to the site. Built
 * only from fixed words, type names and counts: no value ever reaches a
 * notice. UI copy says "stand-in".
 */
import type {
  EntitySubtype,
  EntityType,
  NationalIdSubtype,
  BankSubtype,
} from '../../shared/entities.ts';
import type { NetCategory } from '../../shared/net-protocol.ts';

/**
 * Where the write came from: a writing card (`card`), a message request
 * (`message`), or any other write the user caused (`write`). Surfaces get
 * their own wording only with evidence of their requests from the live site.
 */
export type NoticeSurface = 'card' | 'message' | 'write';

/** The notice surface of a write the net saw (see NetCategory). */
export function noticeSurfaceFor(category: NetCategory): NoticeSurface {
  switch (category) {
    case 'writing-block':
      return 'card';
    case 'message':
      return 'message';
    case 'write':
    case 'other':
      return 'write';
  }
}

/** Early warning while typing (cards only), or a write that was stopped. */
export type NoticeState = 'warning' | 'blocked';

/**
 * found: values the detector (or the email check) found in the user's text.
 * earlier: values the user masked earlier in this chat (types only).
 * unchecked: the write could not be checked (no types known).
 */
export type NoticeReason = 'found' | 'earlier' | 'unchecked';

/** One kind of value and how many of it. */
export interface NoticeItem {
  readonly type: EntityType;
  readonly subtype: EntitySubtype | null;
  readonly count: number;
}

export interface NoticeContent {
  readonly title: string;
  readonly body: string;
}

type Label = readonly [one: string, many: string];

const plural = (one: string): Label => [one, `${one}s`];

const TYPE_LABELS: Readonly<Record<EntityType, Label>> = {
  PERSON: plural('name'),
  ORG: plural('organisation name'),
  ADDRESS: ['address', 'addresses'],
  EMAIL: plural('email'),
  PHONE: plural('phone number'),
  CARD: plural('card number'),
  BANK: plural('bank account number'),
  NATIONAL_ID: plural('national ID number'),
  SECRET: ['API key or password', 'API keys or passwords'],
  IP: ['IP address', 'IP addresses'],
  CRYPTO: ['crypto address', 'crypto addresses'],
  DOB: ['date of birth', 'dates of birth'],
  DATE: plural('date'),
  PASSPORT: plural('passport number'),
  POSTCODE: plural('postcode'),
  CUSTOM: plural('protected term'),
};

const NATIONAL_ID_LABELS: Readonly<Record<NationalIdSubtype, Label>> = {
  US_SSN: plural('SSN'),
  UK_NINO: plural('UK NI number'),
  UK_NHS: plural('NHS number'),
  CA_SIN: plural('SIN'),
  BR_CPF: plural('CPF'),
  IN_AADHAAR: plural('Aadhaar number'),
  IN_VID: plural('VID'),
  IN_PAN: plural('PAN'),
  CN_RIC: plural('Chinese ID number'),
  SG_NRIC: plural('NRIC/FIN'),
  ZA_ID: plural('South African ID number'),
  ES_DNI: plural('DNI/NIE'),
  IT_CF: ['codice fiscale', 'codici fiscali'],
  FR_NIR: plural('NIR'),
  DE_TAXID: plural('tax ID'),
};

const BANK_LABELS: Readonly<Record<BankSubtype, Label>> = {
  IBAN: plural('bank account number'),
  SWIFT_BIC: plural('SWIFT/BIC code'),
  US_ABA: plural('routing number'),
  UK_SORTCODE: plural('sort code'),
  IN_IFSC: plural('IFSC code'),
  IN_UPI: plural('UPI ID'),
};

function labelOf(item: NoticeItem): Label {
  const { type, subtype } = item;
  if (
    type === 'NATIONAL_ID' &&
    subtype !== null &&
    subtype in NATIONAL_ID_LABELS
  ) {
    return NATIONAL_ID_LABELS[subtype as NationalIdSubtype];
  }
  if (type === 'BANK' && subtype !== null && subtype in BANK_LABELS) {
    return BANK_LABELS[subtype as BankSubtype];
  }
  return TYPE_LABELS[type];
}

/** "1 email", "1 email and 2 phone numbers", "a, b and c". */
export function itemList(items: readonly NoticeItem[]): string {
  const parts = items
    .filter((item) => item.count > 0)
    .map((item) => {
      const [one, many] = labelOf(item);
      return `${item.count.toString()} ${item.count === 1 ? one : many}`;
    });
  if (parts.length <= 1) return parts[0] ?? '';
  return `${parts.slice(0, -1).join(', ')} and ${parts.at(-1) ?? ''}`;
}

const total = (items: readonly NoticeItem[]): number =>
  items.reduce((sum, item) => sum + item.count, 0);

const UNCHECKED_BODY =
  "PromptVeil couldn't check it, so it wasn't sent or saved.";

const TITLES: Readonly<Record<NoticeSurface, string>> = {
  card: "This edit wasn't saved",
  message: 'Message not sent',
  write: 'Not saved',
};

/**
 * The notice for a write. With no items (or reason `unchecked`) the notice
 * says the write could not be checked.
 */
export function noticeText(
  surface: NoticeSurface,
  state: NoticeState,
  reason: NoticeReason,
  items: readonly NoticeItem[],
): NoticeContent {
  const listed = itemList(items);
  if (reason === 'unchecked' || listed === '') {
    return { title: TITLES[surface], body: UNCHECKED_BODY };
  }
  const list =
    reason === 'earlier'
      ? `${listed} you protected earlier in this chat`
      : listed;
  if (surface === 'card' && state === 'warning') {
    return {
      title: 'Personal data in this card',
      body: `It has ${list}. While it's there, PromptVeil stops ChatGPT from saving this card, so your edits stay on this screen only. Remove it to keep saving.`,
    };
  }
  switch (surface) {
    case 'card':
      return {
        title: TITLES.card,
        body: `It has ${list}. PromptVeil stopped ChatGPT from storing it. Remove it and your next edit will save; until then, edits are lost if you refresh.`,
      };
    case 'message':
      return {
        title: TITLES.message,
        body:
          reason === 'earlier'
            ? `It has ${list}. Nothing was sent.`
            : `It has ${list} that ${total(items) === 1 ? "wasn't" : "weren't"} replaced by a stand-in. Nothing was sent.`,
      };
    case 'write':
      return {
        title: TITLES.write,
        body: `Something you typed has ${list}. PromptVeil stopped ChatGPT from storing it. Remove it and try again.`,
      };
  }
}

/** Counts values by type and subtype, in a fixed type order. */
export function countItems(
  values: readonly { type: EntityType; subtype: EntitySubtype | null }[],
): NoticeItem[] {
  const counts = new Map<string, NoticeItem>();
  for (const { type, subtype } of values) {
    const key = `${type}|${subtype ?? ''}`;
    const item = counts.get(key);
    counts.set(key, { type, subtype, count: (item?.count ?? 0) + 1 });
  }
  const order = Object.keys(TYPE_ORDER);
  return [...counts.values()].sort(
    (a, b) =>
      order.indexOf(a.type) - order.indexOf(b.type) ||
      (a.subtype ?? '').localeCompare(b.subtype ?? ''),
  );
}

/** Order of types in a list: the masked types first, as in the settings. */
const TYPE_ORDER: Readonly<Record<EntityType, true>> = {
  EMAIL: true,
  PHONE: true,
  CARD: true,
  BANK: true,
  NATIONAL_ID: true,
  SECRET: true,
  DOB: true,
  IP: true,
  CRYPTO: true,
  PERSON: true,
  ORG: true,
  ADDRESS: true,
  DATE: true,
  PASSPORT: true,
  POSTCODE: true,
  CUSTOM: true,
};
