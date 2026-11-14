import type { Detection } from '@/src/shared/entities.ts';
import { detectRules } from '@/src/core/detect/rules/detector.ts';

/** The rule detector run for EMAIL only (tests about email masking). */
export const detectEmailsOnly = (text: string): Promise<Detection[]> =>
  detectRules(text, {
    homeRegions: [],
    entityTypes: new Set(['EMAIL']),
    packs: [],
    exclude: [],
  });
