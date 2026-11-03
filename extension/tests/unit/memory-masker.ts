import type {
  StandInMapping,
  StandInSource,
} from '@/src/core/restore/index.ts';
import { createSpikeMasker } from '@/src/core/spike-mask.ts';
import type { Detection } from '@/src/shared/entities.ts';
import type { MaskItem } from '@/src/shared/vault-protocol.ts';

export interface MemoryMasker {
  transform: (text: string) => Promise<string>;
  source: StandInSource;
  /** Every batch the masker asked stand-ins for. */
  issued: MaskItem[][];
}

/**
 * The spike masker over an in-memory issuer that numbers stand-ins
 * `standin.N@example.net` per masker, for tests that need masking and
 * restoration but not the vault.
 */
export function createMemoryMasker(options: {
  detect: (text: string) => Promise<readonly Detection[]>;
}): MemoryMasker {
  const byKey = new Map<string, StandInMapping>();
  const issuedStandIns = new Set<string>();
  const listeners = new Set<() => void>();
  let mappings: readonly StandInMapping[] = [];
  let version = 0;
  const issued: MaskItem[][] = [];

  const masker = createSpikeMasker({
    detect: options.detect,
    normalise: (detection) => detection.value.toLowerCase(),
    issue: (items) => {
      issued.push([...items]);
      const standIns = items.map((item) => {
        const existing = byKey.get(item.normalised);
        if (existing !== undefined) return existing.standIn;
        const mapping: StandInMapping = {
          standIn: `standin.${(byKey.size + 1).toString()}@example.net`,
          real: item.value,
          boundary: 'email',
        };
        byKey.set(item.normalised, mapping);
        issuedStandIns.add(mapping.standIn);
        mappings = [...byKey.values()];
        version += 1;
        return mapping.standIn;
      });
      for (const listener of listeners) listener();
      return Promise.resolve(standIns);
    },
    isIssued: (value) => issuedStandIns.has(value.toLowerCase()),
  });

  return {
    transform: masker.transform,
    issued,
    source: {
      get version() {
        return version;
      },
      mappings: () => mappings,
      subscribe(listener) {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    },
  };
}
