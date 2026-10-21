/**
 * Spike transform for P1 only: proves send interception and restoration end
 * to end with email addresses. It is replaced by the stand-in engine
 * (P2–P5), which covers every entity type and keeps mappings in the
 * encrypted vault.
 *
 * Mappings live only in this closure for the life of the page.
 */
import type { Detection, EntityType } from '../shared/entities.ts';
import { detectRules } from './detect/rules/detector.ts';
import type { StandInMapping, StandInSource } from './restore/types.ts';
import { isSpikeStandIn } from './spike-standin.ts';

const SESSION_TAG = /^[a-z0-9]{1,8}$/;

export interface SpikeMaskerOptions {
  /**
   * Random tag for this page load, added to every stand-in. Numbering starts
   * again on each page load, so without it a new value could get the same
   * stand-in as a different value in an older message.
   */
  sessionTag?: string;
  /**
   * The rule detector run on a prompt (normally through the draft analyzer,
   * so Send reuses the analysis made while typing). Only confirmed EMAIL
   * detections are masked. Defaults to the detector with EMAIL only.
   */
  detect?: (text: string) => Promise<readonly Detection[]>;
}

/** The spike masks email addresses only, until the stand-in engine (P5/P6). */
export const SPIKE_ENTITY_TYPES: ReadonlySet<EntityType> = new Set(['EMAIL']);

const detectEmailsOnly = (text: string): Promise<Detection[]> =>
  detectRules(text, {
    homeRegions: [],
    entityTypes: SPIKE_ENTITY_TYPES,
    packs: [],
    exclude: [],
  });

export interface SpikeMasker {
  /** Replaces each email with its stand-in. */
  transform: (text: string) => Promise<string>;
  /** The stand-in → real mappings issued so far, for restoration. */
  source: StandInSource;
}

export function createSpikeMasker(
  options: SpikeMaskerOptions = {},
): SpikeMasker {
  const { sessionTag, detect = detectEmailsOnly } = options;
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

  const transform = async (text: string): Promise<string> => {
    const detections = await detect(text);
    let out = '';
    let cursor = 0;
    for (const span of detections) {
      if (span.type !== 'EMAIL' || span.status !== 'confirmed') continue;
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
