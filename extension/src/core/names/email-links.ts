/**
 * Whether an email address belongs to a person: its local part spells the
 * person's name parts (first.last, flast, harrietp…). Shared by the send
 * pipeline (which links the two) and the EMAIL stand-in (which rebuilds the
 * local part from the person's stand-in). Light on purpose: the pipeline
 * runs in the start-up content script.
 */
import { foldName, nameParts } from './parts.ts';

/** Runs of letters, of digits, and of anything else. */
export const LOCAL_TOKEN = /[\p{L}\p{M}]+|\d+|[^\p{L}\p{M}\d]+/gu;
export const LETTERS = /^[\p{L}\p{M}]+$/u;

/** Letters and digits only, accents removed, lower case. */
export function localForm(name: string): string {
  return foldName(name).replace(/[^a-z0-9]/gu, '');
}

/** One name part in a token, whole or as its initial. */
export interface NameUnit {
  readonly part: number;
  readonly initial: boolean;
}

/**
 * `token` (in local form) as a run of the name parts, each whole or as its
 * initial and each at most once, with at least one whole part
 * ("harrietp", "hpemberton", "pembertonharriet"); null when it is not one.
 */
export function nameUnits(
  token: string,
  parts: readonly string[],
): NameUnit[] | null {
  const forms = parts.map(localForm);
  const search = (
    at: number,
    used: number,
    whole: boolean,
  ): NameUnit[] | null => {
    if (at === token.length) return whole ? [] : null;
    for (const [part, form] of forms.entries()) {
      const bit = 2 ** part;
      if (form.length < 2 || Math.floor(used / bit) % 2 === 1) continue;
      if (token.startsWith(form, at)) {
        const rest = search(at + form.length, used + bit, true);
        if (rest !== null) return [{ part, initial: false }, ...rest];
      }
      if (token.charAt(at) === form.charAt(0)) {
        const rest = search(at + 1, used + bit, whole);
        if (rest !== null) return [{ part, initial: true }, ...rest];
      }
    }
    return null;
  };
  return search(0, 0, false);
}

export function splitAddress(email: string): { local: string; domain: string } {
  const at = email.lastIndexOf('@');
  return { local: email.slice(0, at), domain: email.slice(at + 1) };
}

/** The domain of an address, lower case. */
export function emailDomain(email: string): string {
  return splitAddress(email).domain.toLowerCase();
}

/** True when the address's local part spells the person's name parts. */
export function emailMatchesPerson(email: string, person: string): boolean {
  const parts = nameParts(person);
  if (parts.length === 0) return false;
  return (splitAddress(email).local.match(LOCAL_TOKEN) ?? []).some(
    (token) =>
      LETTERS.test(token) && nameUnits(localForm(token), parts) !== null,
  );
}
