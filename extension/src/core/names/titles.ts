/**
 * Titles before a person's name, in several languages (05 §6): removed from
 * the name's normal form, kept as written in its stand-in.
 */

/**
 * Leading titles in several languages, matched after lower-casing. "m." only
 * with its dot, so a bare initial M is kept.
 */
export const TITLES =
  /^(?:(?:mr|mrs|ms|miss|mx|dr|dra|prof|shri|smt|sri|sr|sra|srta|herr|frau|mme|mlle|m\.)\.?\s+)+/u;

const TITLES_ANY_CASE = new RegExp(TITLES.source, 'iu');

/**
 * The length of the leading titles of a name as written ("Dr. ", "Herr "),
 * 0 when it has none or is only titles.
 */
export function titlePrefixLength(value: string): number {
  const length = TITLES_ANY_CASE.exec(value)?.[0].length ?? 0;
  return length === value.length ? 0 : length;
}
