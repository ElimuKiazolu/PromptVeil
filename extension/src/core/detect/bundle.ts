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
import { normaliseReal } from './normal-form.ts';
import {
  clearRuleCaches,
  rulesAnalysis,
  warmUpRules,
} from './rules/analysis.ts';
import { COUNTRY_PACKS, enabledPacks } from './rules/packs/index.ts';
import { createCheckpoint, type Checkpoint, type Yielder } from './schedule.ts';
import {
  generateStandIn,
  WORD_TYPES,
  wordListFor,
} from '../surrogate/engine.ts';
import type {
  StandIn,
  StandInEnvironment,
  StandInRequest,
} from '../surrogate/types.ts';
import { localeForRegion, type LocaleId } from '../surrogate/words/locales.ts';
import { createWordStore, type WordLoader } from '../surrogate/words/store.ts';

/** Changes whenever the module's exports change shape. */
export const DETECTION_API_VERSION = 6;

export interface DetectionConfig {
  readonly homeRegions: readonly CountryCode[];
  readonly preferredRegions: readonly CountryCode[];
  readonly entityTypes: ReadonlySet<EntityType>;
  /** Country pack switches from settings; a missing country counts as on. */
  readonly idPacks: Readonly<Partial<Record<CountryCode, boolean>>>;
  /** ADDRESS stand-ins keep the city (settings.keepCity). */
  readonly keepCity: boolean;
  /** Detect private and other local IP addresses (settings.maskPrivateIps). */
  readonly maskPrivateIps: boolean;
}

/** The parts of a stand-in request that decide its word lists. */
export type WordListRequest = Pick<
  StandInRequest,
  'type' | 'value' | 'country' | 'links'
>;

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
  /**
   * Applies new settings to later analyses. Cached results (made with the
   * old settings) are dropped; an analysis already running finishes with the
   * settings it started with.
   */
  configure(config: DetectionConfig): void;
  /** The vault normal form of a detected value (sent with it to the vault). */
  normalise(detection: Detection): string;
  /**
   * Loads the word lists stand-ins for these requests draw from (PERSON,
   * ORG, ADDRESS, EMAIL); rejects when a file cannot be loaded.
   */
  loadWords(requests: readonly WordListRequest[]): Promise<void>;
  /**
   * The stand-in engine: the stand-in for a value, its seed (from the
   * vault) and an attempt number; null when this attempt has none. Throws
   * for a type without a generator, or when its word lists are not loaded.
   */
  standIn(
    request: StandInRequest,
    seed: Uint8Array,
    attempt: number,
  ): StandIn | null;
}

/** Locales of the home regions, then of the other preferred regions. */
function preferredLocales(config: DetectionConfig): LocaleId[] {
  const out = new Set<LocaleId>();
  for (const region of [...config.homeRegions, ...config.preferredRegions]) {
    const locale = localeForRegion(region);
    if (locale !== undefined) out.add(locale.id);
  }
  return [...out];
}

function noWordLists(): Promise<never> {
  return Promise.reject(new Error('no word loader'));
}

/**
 * `loadWord` reads a bundled word-list file (the content script fetches it
 * from the extension package); without one, stand-ins needing word lists
 * cannot be made.
 */
export function createDetection(
  config: DetectionConfig,
  yielder: Yielder,
  loadWord: WordLoader = noWordLists,
): DetectionRuntime {
  const words = createWordStore(loadWord, () => createCheckpoint(yielder));
  let current = config;
  const env = (): StandInEnvironment => ({
    words,
    preferredLocales: preferredLocales(current),
    keepCity: current.keepCity,
  });
  const analyzerFor = (settings: DetectionConfig) =>
    createDraftAnalyzer({
      analyse: rulesAnalysis({
        homeRegions: settings.homeRegions,
        preferredRegions: settings.preferredRegions,
        entityTypes: settings.entityTypes,
        packs: enabledPacks(COUNTRY_PACKS, settings.idPacks),
        maskPrivateIps: settings.maskPrivateIps,
      }),
      yielder,
      onClear: clearRuleCaches,
    });
  let analyzer = analyzerFor(config);
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
    normalise: (detection) =>
      normaliseReal(
        detection.type,
        detection.subtype,
        detection.country,
        detection.value,
      ),
    loadWords: async (requests) => {
      const needed = requests.filter((request) => WORD_TYPES.has(request.type));
      if (needed.length === 0) return;
      await words.loadIndex();
      const environment = env();
      const locales = needed.flatMap((request) => {
        const locale = wordListFor(request, environment);
        return locale === null ? [] : [locale];
      });
      await words.loadLocales(locales);
    },
    standIn: (request, seed, attempt) =>
      generateStandIn(request, seed, attempt, env()),
    configure: (next) => {
      current = next;
      const previous = analyzer;
      analyzer = analyzerFor(next);
      previous.clear();
    },
  };
}
