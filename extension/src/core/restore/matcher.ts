import type {
  BoundaryRule,
  Replacement,
  RestoreMatcher,
  StandInMapping,
} from './types.ts';

const WORD_CHAR = /[\p{L}\p{N}_]/u;
const EMAIL_BEFORE = /[\p{L}\p{N}._%+-]/u;
const EMAIL_AFTER = /[\p{L}\p{N}_@-]/u;
const ALNUM = /[\p{L}\p{N}]/u;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isDelimited(
  text: string,
  start: number,
  end: number,
  rule: BoundaryRule,
): boolean {
  const before = text.charAt(start - 1);
  const after = text.charAt(end);
  if (rule === 'word') {
    return !WORD_CHAR.test(before) && !WORD_CHAR.test(after);
  }
  if (EMAIL_BEFORE.test(before) || EMAIL_AFTER.test(after)) return false;
  // A dot followed by more domain characters continues the address.
  return !(after === '.' && ALNUM.test(text.charAt(end + 1)));
}

const EMPTY_MATCHER: RestoreMatcher = {
  find: () => [],
  countOccurrences: () => 0,
};

/**
 * Builds a case-insensitive matcher for a set of stand-ins. Matching is a
 * single regular-expression scan, so its cost grows with the text length,
 * not with the number of stand-ins checked one by one.
 */
export function createRestoreMatcher(
  mappings: Iterable<StandInMapping>,
): RestoreMatcher {
  const byKey = new Map<string, StandInMapping>();
  for (const mapping of mappings) {
    if (mapping.standIn === '') continue;
    byKey.set(mapping.standIn.toLowerCase(), mapping);
  }
  if (byKey.size === 0) return EMPTY_MATCHER;

  // Longest first, so a stand-in that extends another wins at the same start.
  const ordered = [...byKey.values()].sort(
    (a, b) => b.standIn.length - a.standIn.length,
  );
  const source = ordered.map((m) => escapeRegExp(m.standIn)).join('|');

  /** A mapping that matches at `index` and is properly delimited. */
  const matchAt = (
    text: string,
    index: number,
    found: string,
  ): StandInMapping | undefined => {
    const first = byKey.get(found.toLowerCase());
    if (
      first &&
      isDelimited(text, index, index + found.length, first.boundary)
    ) {
      return first;
    }
    // The longest candidate was not delimited; try shorter ones here.
    for (const mapping of ordered) {
      const length = mapping.standIn.length;
      if (length >= found.length) continue;
      const slice = text.slice(index, index + length);
      if (
        slice.toLowerCase() === mapping.standIn.toLowerCase() &&
        isDelimited(text, index, index + length, mapping.boundary)
      ) {
        return mapping;
      }
    }
    return undefined;
  };

  return {
    find(text) {
      const pattern = new RegExp(source, 'giu');
      const out: Replacement[] = [];
      for (
        let match = pattern.exec(text);
        match !== null;
        match = pattern.exec(text)
      ) {
        const mapping = matchAt(text, match.index, match[0]);
        if (mapping) {
          const end = match.index + mapping.standIn.length;
          out.push({
            start: match.index,
            end,
            standIn: text.slice(match.index, end),
            real: mapping.real,
          });
          pattern.lastIndex = end;
        } else {
          pattern.lastIndex = match.index + 1;
        }
      }
      return out;
    },

    countOccurrences(text) {
      const pattern = new RegExp(source, 'giu');
      let count = 0;
      for (
        let match = pattern.exec(text);
        match !== null;
        match = pattern.exec(text)
      ) {
        count += 1;
      }
      return count;
    },
  };
}
