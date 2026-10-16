/** One token result from the token-classification pipeline. */
export interface TokenEntity {
  /** IOB label such as B-PER or I-LOC. */
  entity: string;
  /** Token position; consecutive positions belong together. */
  index: number;
}

/**
 * Entity counts by type (PER, ORG, LOC, MISC), never the values. A new
 * entity starts at a B- tag, or at an I- tag that does not continue the
 * previous token's type.
 */
export function countEntities(
  tokens: readonly TokenEntity[],
): Record<string, number> {
  const counts: Record<string, number> = {};
  let previous: { type: string; index: number } | null = null;
  for (const token of [...tokens].sort((a, b) => a.index - b.index)) {
    const match = /^([BI])-(.+)$/.exec(token.entity);
    if (!match) {
      previous = null;
      continue;
    }
    const [, tag = '', type = ''] = match;
    const continues =
      tag === 'I' &&
      previous !== null &&
      previous.type === type &&
      previous.index === token.index - 1;
    if (!continues) counts[type] = (counts[type] ?? 0) + 1;
    previous = { type, index: token.index };
  }
  return counts;
}
