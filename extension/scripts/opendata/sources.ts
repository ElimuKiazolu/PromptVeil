/**
 * The open-data manifest (opendata/sources.json): every source behind the
 * word lists with its licence, attribution and pinned files, and the
 * checksums of the extracted lists built from them.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const OPENDATA = fileURLToPath(
  new URL('../../opendata/', import.meta.url),
);
export const RAW = join(OPENDATA, 'raw');
export const EXTRACTED = join(OPENDATA, 'extracted');
const MANIFEST = join(OPENDATA, 'sources.json');

export interface SourceFile {
  name: string;
  /** Fetched from this URL. */
  url?: string;
  /** A data.gov.sg dataset ID (downloaded through its poll-download API). */
  datagovsg?: string;
  /** A Wikidata count query in opendata/queries/. */
  query?: string;
  /** Labels of the name items of this count result (queries/labels.rq). */
  labelsOf?: string;
  retrieved: string | null;
  sha256: string | null;
  bytes: number | null;
}

export interface Source {
  id: string;
  title: string;
  publisher: string;
  page: string;
  licence: string;
  licenceUrl: string;
  attribution: string;
  use: string;
  files: SourceFile[];
}

export interface Sources {
  note: string;
  sources: Source[];
  skipped: { id: string; title: string; reason: string }[];
  /** Extracted file name → SHA-256 of its contents. */
  extracted: Record<string, string>;
}

export function readSources(): Sources {
  return JSON.parse(readFileSync(MANIFEST, 'utf8')) as Sources;
}

export function writeSources(sources: Sources): void {
  writeFileSync(MANIFEST, `${JSON.stringify(sources, null, 2)}\n`);
}

/** A source's raw file. */
export function rawFile(sourceId: string, name: string): string {
  return join(RAW, sourceId, name);
}
