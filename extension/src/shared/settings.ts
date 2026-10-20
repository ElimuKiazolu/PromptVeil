/**
 * Settings kept in chrome.storage.local: shape and defaults only. Reading,
 * writing and migrating them belongs to the settings store.
 */
import type { CountryCode } from './country.ts';
import type { EntityType } from './entities.ts';

export type SiteId = 'chatgpt' | 'gemini' | 'claude';

export type Mode = 'review' | 'auto';

export interface Settings {
  /** Global switch. */
  enabled: boolean;
  /** Epoch ms; null when not paused. */
  pausedUntil: number | null;
  sites: Record<SiteId, { enabled: boolean }>;
  mode: Mode;
  entityTypes: Record<EntityType, boolean>;
  /** Set at onboarding; decide stand-in formats and which regions are tried first. */
  homeRegions: readonly CountryCode[];
  /** Country ID pack on/off. A country without an entry is on (every pack runs by default). */
  idPacks: Partial<Record<CountryCode, boolean>>;
  /** NER confidence below which an item is only shown as "possible". */
  nerThreshold: number;
  /** Keep the city (and country) of an address unchanged in its stand-in. */
  keepCity: boolean;
  riskMeter: { enabled: boolean; confirmOnHigh: boolean };
  /** Days before unused conversation mappings are deleted; 0 keeps them forever. */
  retentionDays: number;
  restoreTooltips: boolean;
  onboardingDone: boolean;
}

/**
 * Defaults for a fresh install. Deeply read-only: copy before changing.
 * `homeRegions` starts empty and is filled from the browser locale when
 * settings are first created, then confirmed at onboarding.
 */
export const DEFAULT_SETTINGS = {
  enabled: true,
  pausedUntil: null,
  sites: {
    chatgpt: { enabled: true },
    gemini: { enabled: true },
    claude: { enabled: true },
  },
  mode: 'review',
  entityTypes: {
    PERSON: true,
    ORG: true,
    ADDRESS: true,
    EMAIL: true,
    PHONE: true,
    CARD: true,
    BANK: true,
    NATIONAL_ID: true,
    SECRET: true,
    IP: true,
    CRYPTO: true,
    DOB: true,
    DATE: true,
    PASSPORT: true,
    POSTCODE: true,
    CUSTOM: true,
  },
  homeRegions: [],
  idPacks: {
    US: true,
    GB: true,
    CA: true,
    BR: true,
    IN: true,
    CN: true,
    SG: true,
    ZA: true,
    ES: true,
    IT: true,
    FR: true,
    DE: true,
  },
  nerThreshold: 0.6,
  keepCity: true,
  riskMeter: { enabled: true, confirmOnHigh: true },
  retentionDays: 30,
  restoreTooltips: true,
  onboardingDone: false,
} as const satisfies Settings;
