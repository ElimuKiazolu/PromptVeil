/**
 * The extracted open-data lists (opendata/extracted/<locale>.json, written by
 * npm run opendata:extract), read back for the word-list build and checked
 * against the checksums recorded in opendata/sources.json.
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EXTRACTED, readSources } from './sources.ts';

/** What a locale gets from the open data (fields it does not get are absent). */
export interface ExtractedLocale {
  locale: string;
  /** Source IDs in opendata/sources.json. */
  sources: string[];
  given?: { female: string[]; male: string[]; neutral: string[] };
  family?: string[];
  legal?: string[];
  streetTypes?: string[];
  streetTypeOrder?: 'before' | 'after';
  localities?: string[];
  streets?: string[];
}

/** Every extracted file, in name order; throws if one differs from its checksum. */
export function readExtracted(): ExtractedLocale[] {
  const { extracted } = readSources();
  const names = readdirSync(EXTRACTED)
    .filter((name) => name.endsWith('.json'))
    .sort();
  const recorded = Object.keys(extracted).sort();
  if (JSON.stringify(names) !== JSON.stringify(recorded)) {
    throw new Error('extracted files differ from the recorded list');
  }
  return names.map((name) => {
    const contents = readFileSync(join(EXTRACTED, name), 'utf8');
    const sha256 = createHash('sha256').update(contents).digest('hex');
    if (sha256 !== extracted[name]) {
      throw new Error(`${name} differs from its recorded checksum`);
    }
    return JSON.parse(contents) as ExtractedLocale;
  });
}
