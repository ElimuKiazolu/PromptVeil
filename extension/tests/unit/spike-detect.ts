import type { Detection } from '@/src/shared/entities.ts';
import { detectRules } from '@/src/core/detect/rules/detector.ts';
import { LIVE_ENTITY_TYPES } from '@/src/core/masker.ts';

/** The rule detector as the live sites use it until P6: EMAIL only. */
export const detectEmailsOnly = (text: string): Promise<Detection[]> =>
  detectRules(text, {
    homeRegions: [],
    entityTypes: LIVE_ENTITY_TYPES,
    packs: [],
    exclude: [],
  });
