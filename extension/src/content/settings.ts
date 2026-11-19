/**
 * The settings the send pipeline uses, read from chrome.storage.local (one
 * key per Settings field) with the defaults for anything missing or
 * malformed, and kept current when they change. A read that fails also
 * falls back to the defaults: they switch every type and pack on, so a
 * storage failure only ever means masking more.
 */
import { MASKABLE_TYPES } from '@/src/core/pipeline.ts';
import { isCountryCode, type CountryCode } from '@/src/shared/country.ts';
import { devlog } from '@/src/shared/devlog.ts';
import type { EntityType } from '@/src/shared/entities.ts';
import { DEFAULT_SETTINGS } from '@/src/shared/settings.ts';

export interface PipelineSettings {
  /** Types masked: switched on in settings and with a stand-in generator. */
  readonly entityTypes: ReadonlySet<EntityType>;
  readonly idPacks: Readonly<Partial<Record<CountryCode, boolean>>>;
  /** From settings; empty until onboarding stores them. */
  readonly homeRegions: readonly CountryCode[];
  /** ADDRESS stand-ins keep the city. */
  readonly keepCity: boolean;
  /** Private and other local IP addresses are masked too. */
  readonly maskPrivateIps: boolean;
}

const KEYS = [
  'entityTypes',
  'idPacks',
  'homeRegions',
  'keepCity',
  'maskPrivateIps',
] as const;

export interface SettingsStorageLike {
  get(keys: string[]): Promise<Record<string, unknown>>;
}

type ChangeListener = (
  changes: Record<string, { newValue?: unknown }>,
  areaName: string,
) => void;

export interface SettingsChangesLike {
  addListener(listener: ChangeListener): void;
  removeListener(listener: ChangeListener): void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function entityTypes(value: unknown): ReadonlySet<EntityType> {
  const switches: Record<string, unknown> = isRecord(value)
    ? value
    : DEFAULT_SETTINGS.entityTypes;
  return new Set(
    [...MASKABLE_TYPES].filter(
      // Only an explicit false switches a type off.
      (type) => switches[type] !== false,
    ),
  );
}

function idPacks(value: unknown): Partial<Record<CountryCode, boolean>> {
  if (!isRecord(value)) return { ...DEFAULT_SETTINGS.idPacks };
  const out: Partial<Record<CountryCode, boolean>> = {};
  for (const [country, on] of Object.entries(value)) {
    if (isCountryCode(country) && typeof on === 'boolean') out[country] = on;
  }
  return out;
}

function homeRegions(value: unknown): CountryCode[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (entry): entry is CountryCode =>
      typeof entry === 'string' && isCountryCode(entry),
  );
}

/** The pipeline settings from stored values, field by field. */
export function parsePipelineSettings(
  stored: Readonly<Record<string, unknown>>,
): PipelineSettings {
  return {
    entityTypes: entityTypes(stored.entityTypes),
    idPacks: idPacks(stored.idPacks),
    homeRegions: homeRegions(stored.homeRegions),
    keepCity:
      typeof stored.keepCity === 'boolean'
        ? stored.keepCity
        : DEFAULT_SETTINGS.keepCity,
    maskPrivateIps:
      typeof stored.maskPrivateIps === 'boolean'
        ? stored.maskPrivateIps
        : DEFAULT_SETTINGS.maskPrivateIps,
  };
}

export const DEFAULT_PIPELINE_SETTINGS: PipelineSettings =
  parsePipelineSettings({});

export interface SettingsWatcher {
  /** The settings once read (defaults if the read failed). */
  ready(): Promise<PipelineSettings>;
  /** Called with the new settings after every change. */
  subscribe(listener: (settings: PipelineSettings) => void): () => void;
  dispose(): void;
}

export function watchSettings(
  area: SettingsStorageLike,
  changes: SettingsChangesLike,
): SettingsWatcher {
  let stored: Record<string, unknown> = {};
  let isLoaded = false;
  /** Changes seen while the first read runs: newer than what it returns. */
  const early: [string, unknown][] = [];
  const listeners = new Set<(settings: PipelineSettings) => void>();

  const apply = (key: string, value: unknown): void => {
    const rest = Object.fromEntries(
      Object.entries(stored).filter(([name]) => name !== key),
    );
    stored = value === undefined ? rest : { ...rest, [key]: value };
  };

  const loaded = area.get([...KEYS]).then(
    (values) => {
      stored = { ...values };
      for (const [key, value] of early.splice(0)) apply(key, value);
      isLoaded = true;
      devlog('settings.loaded');
      return parsePipelineSettings(stored);
    },
    (error: unknown) => {
      isLoaded = true;
      devlog('settings.failed', { error });
      return DEFAULT_PIPELINE_SETTINGS;
    },
  );

  const onChange: ChangeListener = (changed, areaName) => {
    if (areaName !== 'local') return;
    let relevant = false;
    for (const key of KEYS) {
      const change = changed[key];
      if (change === undefined) continue;
      relevant = true;
      if (isLoaded) apply(key, change.newValue);
      else early.push([key, change.newValue]);
    }
    if (!relevant || !isLoaded) return;
    const settings = parsePipelineSettings(stored);
    for (const listener of listeners) listener(settings);
  };
  changes.addListener(onChange);

  return {
    ready: () => loaded,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    dispose() {
      changes.removeListener(onChange);
      listeners.clear();
    },
  };
}

/** Home regions from settings, else from the browser's languages. */
export function effectiveHomeRegions(
  settings: PipelineSettings,
  languageRegions: readonly CountryCode[],
): readonly CountryCode[] {
  return settings.homeRegions.length > 0
    ? settings.homeRegions
    : languageRegions;
}
