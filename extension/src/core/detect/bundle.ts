/**
 * Entry point of the detection module: the rule detector, the phone
 * library and its metadata, and the country packs, built as one ES module
 * that the content script loads after the page has started (see
 * src/content/detection-loader.ts). Keeping it out of the document_start
 * script keeps page start-up fast.
 *
 * Importing this module must stay cheap: nothing heavy runs at the top level.
 * Lookup tables (the phone region index, compiled metadata patterns) are
 * built by warmUp(), in slices.
 */
import type { CountryCode } from '../../shared/country.ts';
import type { Detection, EntityType } from '../../shared/entities.ts';
import { createDraftAnalyzer } from '../draft/analyzer.ts';
import {
  clearRuleCaches,
  rulesAnalysis,
  warmUpRules,
} from './rules/analysis.ts';
import { COUNTRY_PACKS, enabledPacks } from './rules/packs/index.ts';
import type { Checkpoint, Yielder } from './schedule.ts';

/** Changes whenever the module's exports change shape. */
export const DETECTION_API_VERSION = 1;

export interface DetectionConfig {
  readonly homeRegions: readonly CountryCode[];
  readonly preferredRegions: readonly CountryCode[];
  readonly entityTypes: ReadonlySet<EntityType>;
  /** Country pack switches from settings; a missing country counts as on. */
  readonly idPacks: Readonly<Partial<Record<CountryCode, boolean>>>;
}

/** Draft analysis with the rules, plus warm-up and cache control. */
export interface DetectionRuntime {
  /** The detections in exactly this text (Send). */
  analyse(text: string): Promise<Detection[]>;
  /** Background pre-pass while the user writes. */
  prepare(text: string): Promise<void>;
  /** Forgets cached results (they hold real values). */
  clear(): void;
  /** clear(), for good. */
  dispose(): void;
  /** Builds lookup tables and compiles patterns, yielding at the checkpoint. */
  warmUp(checkpoint: Checkpoint): Promise<void>;
}

export function createDetection(
  config: DetectionConfig,
  yielder: Yielder,
): DetectionRuntime {
  const analyzer = createDraftAnalyzer({
    analyse: rulesAnalysis({
      homeRegions: config.homeRegions,
      preferredRegions: config.preferredRegions,
      entityTypes: config.entityTypes,
      packs: enabledPacks(COUNTRY_PACKS, config.idPacks),
    }),
    yielder,
    onClear: clearRuleCaches,
  });
  return {
    analyse: (text) => analyzer.analyse(text),
    prepare: (text) => analyzer.prepare(text),
    clear: () => {
      analyzer.clear();
    },
    dispose: () => {
      analyzer.dispose();
    },
    warmUp: (checkpoint) => warmUpRules(checkpoint),
  };
}
