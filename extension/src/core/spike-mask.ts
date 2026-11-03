/**
 * Spike transform: masks email addresses only, with stand-ins issued by the
 * vault (in the spike's `standin.N.tag@example.net` format). It is replaced
 * by the stand-in engine (P5/P6), which covers every entity type.
 */
import type { Detection, EntityType } from '../shared/entities.ts';
import type { MaskItem } from '../shared/vault-protocol.ts';
import { isSpikeStandIn } from './spike-standin.ts';

export interface SpikeMaskerOptions {
  /**
   * The rule detector run on a prompt (through the draft analyzer of the
   * detection module, so Send reuses the analysis made while typing). Only
   * confirmed EMAIL detections are masked.
   */
  detect: (text: string) => Promise<readonly Detection[]>;
  /** The vault normal form of a detection. */
  normalise: (detection: Detection) => string | Promise<string>;
  /**
   * One stand-in per item, in order (the vault). Rejects if any item could
   * not be masked; the send is then blocked.
   */
  issue: (items: readonly MaskItem[]) => Promise<readonly string[]>;
  /** True for a stand-in already issued in the current conversation. */
  isIssued: (value: string) => boolean;
}

/** The spike masks email addresses only, until the stand-in engine (P5/P6). */
export const SPIKE_ENTITY_TYPES: ReadonlySet<EntityType> = new Set(['EMAIL']);

export interface SpikeMasker {
  /** Replaces each email with its stand-in. */
  transform: (text: string) => Promise<string>;
}

/** Identifies one value for the vault: type, subtype and normal form. */
function itemKey(item: MaskItem): string {
  return JSON.stringify([item.type, item.subtype, item.normalised]);
}

export function createSpikeMasker(options: SpikeMaskerOptions): SpikeMasker {
  const { detect, normalise, issue, isIssued } = options;

  const transform = async (text: string): Promise<string> => {
    const detections = await detect(text);
    const spans: { detection: Detection; key: string }[] = [];
    const items = new Map<string, MaskItem>();
    for (const detection of detections) {
      if (detection.type !== 'EMAIL' || detection.status !== 'confirmed') {
        continue;
      }
      // A stand-in (edited or regenerated message, or one from an earlier
      // page load) is left as it is rather than masked a second time.
      if (isIssued(detection.value) || isSpikeStandIn(detection.value)) {
        continue;
      }
      const item: MaskItem = {
        type: detection.type,
        subtype: detection.subtype,
        country: detection.country,
        value: detection.value,
        normalised: await normalise(detection),
      };
      const key = itemKey(item);
      // Each value goes to the vault once, however often it appears.
      if (!items.has(key)) items.set(key, item);
      spans.push({ detection, key });
    }
    if (spans.length === 0) return text;

    const unique = [...items.entries()];
    const standIns = await issue(unique.map(([, item]) => item));
    if (standIns.length !== unique.length) {
      throw new RangeError('one stand-in per item expected');
    }
    const byKey = new Map(
      unique.map(([key], index) => [key, standIns[index]] as const),
    );

    let out = '';
    let cursor = 0;
    for (const { detection, key } of spans) {
      const standIn = byKey.get(key);
      if (standIn === undefined) throw new RangeError('missing stand-in');
      out += text.slice(cursor, detection.start) + standIn;
      cursor = detection.end;
    }
    return out + text.slice(cursor);
  };

  return { transform };
}
