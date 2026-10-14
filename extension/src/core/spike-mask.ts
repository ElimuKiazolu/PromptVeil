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

const SPIKE_STAND_IN = /^standin\.\d+(?:\.[a-z0-9]{1,8})?@example\.net$/i;
const SESSION_TAG = /^[a-z0-9]{1,8}$/;

/**
 * True for an address in the spike's stand-in format. example.net is a
 * reserved documentation domain, so no real address has this form; stand-ins
 * from an earlier page load (before the vault exists) are recognised by it.
 */
export function isSpikeStandIn(email: string): boolean {
  return SPIKE_STAND_IN.test(email.trim());
}

export interface SpikeMaskerOptions {
  /**
   * Random tag for this page load, added to every stand-in. Numbering starts
   * again on each page load, so without it a new value could get the same
   * stand-in as a different value in an older message.
   */
  sessionTag?: string;
}

export interface SpikeMasker {
  /** Replaces each email with its stand-in. */
  transform: (text: string) => string;
  /** The stand-in → real mappings issued so far, for restoration. */
  source: StandInSource;
}

export function createSpikeMasker(
  options: SpikeMaskerOptions = {},
): SpikeMasker {
  const { sessionTag } = options;
  if (sessionTag !== undefined && !SESSION_TAG.test(sessionTag)) {
    throw new RangeError('session tag must be 1-8 lowercase letters or digits');
  }
  const suffix = sessionTag === undefined ? '' : `.${sessionTag}`;

  const byReal = new Map<string, StandInMapping>();
  const issued = new Set<string>();
  let mappings: readonly StandInMapping[] = [];
  let version = 0;

  const standInFor = (email: string): string => {
    const key = email.toLowerCase();
    const existing = byReal.get(key);
    if (existing) return existing.standIn;
    const number = (byReal.size + 1).toString();
    const mapping: StandInMapping = {
      standIn: `standin.${number}${suffix}@example.net`,
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
      // A stand-in (edited or regenerated message, or one from an earlier
      // page load) is left as it is rather than masked a second time.
      const isStandIn =
        issued.has(span.value.toLowerCase()) || isSpikeStandIn(span.value);
      out += isStandIn ? span.value : standInFor(span.value);
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
