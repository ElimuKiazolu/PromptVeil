import type {
  BoundaryRule,
  Replacement,
  RestoreMatcher,
  StandInMapping,
} from './types.ts';
import { createVariantFinder } from './variants.ts';

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
  if (rule !== 'email') {
    return !WORD_CHAR.test(before) && !WORD_CHAR.test(after);
  }
  if (EMAIL_BEFORE.test(before) || EMAIL_AFTER.test(after)) return false;
  // A dot followed by more domain characters continues the address.
  return !(after === '.' && ALNUM.test(text.charAt(end + 1)));
}

const isCapitals = (text: string): boolean =>
  text === text.toUpperCase() && text !== text.toLowerCase();

/**
 * A name part counts only as written or in capitals; an exact-case value
 * only as written.
 */
function caseFits(shown: string, mapping: StandInMapping): boolean {
  if (mapping.boundary === 'exact') return shown === mapping.standIn;
  // A derived name is capitalised or in capitals, as names are in prose;
  // in lower case it is an ordinary word (hale, park).
  if (mapping.boundary === 'derived') {
    const shape = caseShape(shown);
    return shape === 'capital' || shape === 'upper';
  }
  return (
    mapping.boundary !== 'name' ||
    shown === mapping.standIn ||
    (isCapitals(shown) && shown === mapping.standIn.toUpperCase())
  );
}

/** How a derived name is written: lower case, capitalised or capitals. */
function caseShape(shown: string): 'lower' | 'capital' | 'upper' | null {
  if (shown === shown.toLowerCase()) return 'lower';
  if (isCapitals(shown)) return 'upper';
  const first = shown.charAt(0);
  const rest = shown.slice(1);
  return first !== first.toLowerCase() && rest === rest.toLowerCase()
    ? 'capital'
    : null;
}

/** An address or a name part shown in capitals comes back in capitals. */
function realAsShown(shown: string, mapping: StandInMapping): string {
  if (mapping.boundary === 'word' || mapping.boundary === 'exact') {
    return mapping.real;
  }
  if (mapping.boundary === 'derived') {
    const real = mapping.real.toLowerCase();
    switch (caseShape(shown)) {
      case 'upper':
        return real.toUpperCase();
      case 'capital':
        return real.charAt(0).toUpperCase() + real.slice(1);
      default:
        return real;
    }
  }
  return isCapitals(shown) ? mapping.real.toUpperCase() : mapping.real;
}

const EMPTY_MATCHER: RestoreMatcher = {
  find: () => [],
  countOccurrences: () => 0,
};

/**
 * Builds a case-insensitive matcher for stand-ins as they were shown.
 * Matching is a single regular-expression scan, so its cost grows with the
 * text length, not with the number of stand-ins checked one by one.
 */
function createExactMatcher(
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
      isDelimited(text, index, index + found.length, first.boundary) &&
      caseFits(found, first)
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
        isDelimited(text, index, index + length, mapping.boundary) &&
        caseFits(slice, mapping)
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
          const shown = text.slice(match.index, end);
          out.push({
            start: match.index,
            end,
            standIn: shown,
            real: realAsShown(shown, mapping),
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

/**
 * Builds the matcher for a conversation's stand-ins: as shown (any case),
 * and for stand-ins with variants (see variants.ts) in their other forms.
 * Where matches overlap, the earliest wins, then the longest; a match of a
 * stand-in's variants wins over the same span as shown, since it carries
 * the reply's layout.
 */
export function createRestoreMatcher(
  mappings: Iterable<StandInMapping>,
): RestoreMatcher {
  const all = [...mappings].filter((mapping) => mapping.standIn !== '');
  const exact = createExactMatcher(all);
  // Name parts are often ordinary words too; the whole names they come
  // from are counted.
  const plain = createExactMatcher(
    all.filter(
      (mapping) =>
        mapping.variants === undefined &&
        mapping.boundary !== 'name' &&
        mapping.boundary !== 'derived',
    ),
  );
  const variants = createVariantFinder(all);
  if (all.length === 0) return EMPTY_MATCHER;

  return {
    find(text) {
      const shown = variants.find(text).map((match): Replacement => ({
        ...match,
        standIn: text.slice(match.start, match.end),
      }));
      // Stable sort: variant matches stay ahead of equal exact ones.
      const candidates = [...shown, ...exact.find(text)].sort(
        (a, b) => a.start - b.start || b.end - a.end,
      );
      const chosen: Replacement[] = [];
      let end = 0;
      for (const candidate of candidates) {
        if (candidate.start < end) continue;
        chosen.push(candidate);
        end = candidate.end;
      }
      const lastFour = variants
        .findLastFour(text, chosen)
        .map((match): Replacement => ({
          ...match,
          standIn: text.slice(match.start, match.end),
        }));
      if (lastFour.length === 0) return chosen;
      return [...chosen, ...lastFour].sort((a, b) => a.start - b.start);
    },

    countOccurrences(text) {
      return plain.countOccurrences(text) + variants.count(text);
    },
  };
}
