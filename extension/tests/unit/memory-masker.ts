import type {
  StandInMapping,
  StandInSource,
} from '@/src/core/restore/index.ts';
import {
  createMasker,
  type CommittedValue,
  type IssueVault,
  type PreparedValue,
  type StandInFactory,
} from '@/src/core/masker.ts';
import type { Detection } from '@/src/shared/entities.ts';
import type { MaskItem } from '@/src/shared/vault-protocol.ts';

export interface MemoryMasker {
  transform: (text: string) => Promise<string>;
  source: StandInSource;
  /** Every batch the masker asked the vault to prepare. */
  issued: MaskItem[][];
}

/** `standin.N@example.net`, N the mapping number plus the attempt. */
export const numberedStandIns: StandInFactory = (request, _seed, attempt) => {
  const value = `standin.${(request.number + attempt).toString()}@example.net`;
  return { value, normalised: value, reserved: true };
};

/**
 * The masker over an in-memory vault that numbers stand-ins
 * `standin.N@example.net` per masker, for tests that need masking and
 * restoration but not the real vault.
 */
export function createMemoryMasker(options: {
  detect: (text: string) => Promise<readonly Detection[]>;
}): MemoryMasker {
  const byKey = new Map<string, StandInMapping>();
  const usedStandIns = new Set<string>();
  const listeners = new Set<() => void>();
  let mappings: readonly StandInMapping[] = [];
  let version = 0;
  const issued: MaskItem[][] = [];

  const vault: IssueVault = {
    prepare: (items) => {
      issued.push([...items]);
      let fresh = 0;
      const values = items.map((item): PreparedValue => {
        const existing = byKey.get(item.normalised);
        if (existing !== undefined) {
          return { kind: 'existing', standIn: existing.standIn };
        }
        fresh += 1;
        return {
          kind: 'new',
          seed: new Uint8Array(32),
          number: byKey.size + fresh,
        };
      });
      return Promise.resolve({ dateOffsetDays: 30, values });
    },
    commit: (entries) => {
      const values = entries.map((entry): CommittedValue => {
        const existing = byKey.get(entry.item.normalised);
        if (existing !== undefined) {
          return { kind: 'existing', standIn: existing.standIn };
        }
        if (usedStandIns.has(entry.standIn.toLowerCase())) {
          return { kind: 'taken' };
        }
        byKey.set(entry.item.normalised, {
          standIn: entry.standIn,
          real: entry.item.value,
          boundary: 'email',
        });
        usedStandIns.add(entry.standIn.toLowerCase());
        return { kind: 'inserted', standIn: entry.standIn };
      });
      mappings = [...byKey.values()];
      version += 1;
      for (const listener of listeners) listener();
      return Promise.resolve(values);
    },
  };

  const masker = createMasker({
    detect: options.detect,
    normalise: (detection) => detection.value.toLowerCase(),
    engine: () => Promise.resolve(numberedStandIns),
    mask: (_items, issue) => issue(vault),
    isIssued: (value) => usedStandIns.has(value.toLowerCase()),
    entityTypes: new Set(['EMAIL']),
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
