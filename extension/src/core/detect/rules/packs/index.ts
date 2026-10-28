/**
 * Country ID packs. Each pack is one file, `packs/{cc}.ts`, exporting a
 * CountryPack: its rules (patterns, validators, context words), all for its
 * own country, plus what the stand-in generator (P5) needs to make a value of
 * the same format that passes the same validator.
 *
 * Packs are switched on and off per country in settings (`idPacks`); a
 * country missing from that map counts as on (TR-R4).
 */
import type { CountryCode } from '../../../../shared/country.ts';
import type { EntitySubtype } from '../../../../shared/entities.ts';
import type { Rule } from '../types.ts';
import { BR_PACK } from './br.ts';
import { CA_PACK } from './ca.ts';
import { CN_PACK } from './cn.ts';
import { DE_PACK } from './de.ts';
import { ES_PACK } from './es.ts';
import { FR_PACK } from './fr.ts';
import { GB_PACK } from './gb.ts';
import { IN_PACK } from './in.ts';
import { IT_PACK } from './it.ts';
import { SG_PACK } from './sg.ts';
import { US_PACK } from './us.ts';
import { ZA_PACK } from './za.ts';

/** Check algorithms a stand-in generator may need to satisfy. */
export type ChecksumKind =
  | 'luhn'
  | 'verhoeff'
  | 'iso7064-mod11-2'
  | 'iso7064-mod11-10'
  | 'iso7064-mod97-10'
  | 'weighted-mod11'
  | 'mod23-letter'
  | 'pack-specific';

export interface StandInSpec {
  /**
   * Formats as written, "#" for a digit and "A" for a letter, e.g.
   * "###-##-####"; the stand-in keeps the format of the real value.
   */
  readonly formats: readonly string[];
  readonly checksum: ChecksumKind | null;
  /**
   * Computes the check characters for a payload (the value's characters
   * before them, without separators); null for formats without any.
   */
  readonly checkCharacters: ((payload: string) => string | null) | null;
  /** The pack's validator: every generated stand-in must pass it. */
  readonly isValid: (value: string) => boolean;
  /** Ranges and values the validator rejects, which a stand-in must avoid. */
  readonly avoid: readonly string[];
}

export interface CountryPack {
  readonly country: CountryCode;
  /** Every rule has this pack's country and one of its subtypes. */
  readonly rules: readonly Rule[];
  readonly standIns: Readonly<Partial<Record<EntitySubtype, StandInSpec>>>;
}

/** Throws if a pack's rules do not belong to it or its ids are not unique. */
export function assertValidPack(pack: CountryPack): void {
  const ids = new Set<string>();
  for (const rule of pack.rules) {
    if (rule.country !== pack.country) {
      throw new Error(
        `pack ${pack.country}: rule ${rule.id} has another country`,
      );
    }
    if (rule.subtype === null || pack.standIns[rule.subtype] === undefined) {
      throw new Error(
        `pack ${pack.country}: rule ${rule.id} has no stand-in spec`,
      );
    }
    if (ids.has(rule.id)) {
      throw new Error(`pack ${pack.country}: duplicate rule id ${rule.id}`);
    }
    ids.add(rule.id);
  }
}

/** The packs that are switched on, in the given order. */
export function enabledPacks(
  packs: readonly CountryPack[],
  idPacks: Readonly<Partial<Record<CountryCode, boolean>>>,
): CountryPack[] {
  return packs.filter((pack) => idPacks[pack.country] !== false);
}

/**
 * Every country pack shipped, in tie-break order (TR-R3 falls back to rule
 * order). These are the 12 P0 packs of TR §4.2.
 */
export const COUNTRY_PACKS: readonly CountryPack[] = [
  US_PACK,
  GB_PACK,
  CA_PACK,
  BR_PACK,
  IN_PACK,
  CN_PACK,
  SG_PACK,
  ZA_PACK,
  ES_PACK,
  IT_PACK,
  FR_PACK,
  DE_PACK,
];
