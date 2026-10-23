import type { Detection } from '@/src/shared/entities.ts';
import { detectRules } from '@/src/core/detect/rules/detector.ts';
import { SPIKE_ENTITY_TYPES } from '@/src/core/spike-mask.ts';

/** The rule detector as the spike uses it: EMAIL only. */
export const detectEmailsOnly = (text: string): Promise<Detection[]> =>
  detectRules(text, {
    homeRegions: [],
    entityTypes: SPIKE_ENTITY_TYPES,
    packs: [],
    exclude: [],
  });
