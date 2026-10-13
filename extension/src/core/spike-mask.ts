/**
 * Spike transform for P1 only: proves send interception and restoration end
 * to end with email addresses. It is replaced by the stand-in engine
 * (P2–P5), which covers every entity type and keeps mappings in the
 * encrypted vault.
 *
 * Mappings live only in this closure for the life of the page.
 */
import { detectEmails } from './detect/rules/email.ts';
import type { StandInMapping, StandInSource } from './restore/types.ts';

export interface SpikeMasker {
  /** Replaces each email with its stand-in. */
  transform: (text: string) => string;
  /** The stand-in → real mappings issued so far, for restoration. */
  source: StandInSource;
}

export function createSpikeMasker(): SpikeMasker {
  const byReal = new Map<string, StandInMapping>();
  const issued = new Set<string>();
  let mappings: readonly StandInMapping[] = [];
  let version = 0;

  const standInFor = (email: string): string => {
    const key = email.toLowerCase();
    const existing = byReal.get(key);
    if (existing) return existing.standIn;
    const mapping: StandInMapping = {
      standIn: `standin.${(byReal.size + 1).toString()}@example.net`,
      real: email,
      boundary: 'email',
    };
    byReal.set(key, mapping);
    issued.add(mapping.standIn);
    mappings = [...byReal.values()];
    version += 1;
    return mapping.standIn;
  };

  const transform = (text: string): string => {
    let out = '';
    let cursor = 0;
    for (const span of detectEmails(text)) {
      out += text.slice(cursor, span.start);
      // A stand-in already issued here (edited or regenerated message) is
      // left as it is rather than masked a second time.
      out += issued.has(span.value.toLowerCase())
        ? span.value
        : standInFor(span.value);
      cursor = span.end;
    }
    return out + text.slice(cursor);
  };

  return {
    transform,
    source: {
      get version() {
        return version;
      },
      mappings: () => mappings,
    },
  };
}
