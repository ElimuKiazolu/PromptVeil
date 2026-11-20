/**
 * Downloads the open data listed in opendata/sources.json into opendata/raw/
 * (not committed) and checks each file against its pinned SHA-256.
 * Development time only: the extension never downloads word lists.
 *
 *   npm run opendata:fetch               download and verify
 *   npm run opendata:fetch -- --update   download, then record the new
 *                                         checksums, sizes and dates
 *
 * Wikidata files are query results: the count queries are in
 * opendata/queries/, and each "labelsOf" file is the labels query
 * (queries/labels.rq) for the name items of its count result. A source that
 * changes (GeoNames is updated daily, Wikidata continuously) fails the check
 * until refreshed with --update and reviewed.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  OPENDATA,
  RAW,
  readSources,
  writeSources,
  type SourceFile,
} from './sources.ts';

const USER_AGENT =
  'PromptVeil-wordlists/1.0 (development build script; no runtime use)';
const update = process.argv.includes('--update');
const today = new Date().toISOString().slice(0, 10);

const sha256 = (bytes: Uint8Array): string =>
  createHash('sha256').update(bytes).digest('hex');

async function withRetries<T>(
  what: string,
  task: () => Promise<T>,
): Promise<T> {
  let last: unknown = null;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      return await task();
    } catch (error) {
      last = error;
      console.log(`retry ${attempt.toString()} ${what}`);
      await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
    }
  }
  throw new Error(`${what} failed`, { cause: last });
}

async function download(
  url: string,
  post?: { headers: Record<string, string>; body: string },
): Promise<Buffer> {
  const response = await fetch(url, {
    method: post === undefined ? 'GET' : 'POST',
    headers: { 'User-Agent': USER_AGENT, ...post?.headers },
    ...(post === undefined ? {} : { body: post.body }),
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status.toString()} for ${url}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

function sparql(query: string): Promise<Buffer> {
  return download('https://query.wikidata.org/sparql', {
    headers: {
      'Content-Type': 'application/sparql-query',
      Accept: 'application/sparql-results+json',
    },
    body: query,
  });
}

/** The labels query for the name items of a count result. */
function labelsQuery(countResult: Buffer): string {
  const parsed = JSON.parse(countResult.toString('utf8')) as {
    results: { bindings: { name?: { value: string } }[] };
  };
  const ids = parsed.results.bindings
    .map((row) => row.name?.value.split('/').pop() ?? '')
    .filter((id) => /^Q\d+$/u.test(id))
    .sort();
  const template = readFileSync(join(OPENDATA, 'queries', 'labels.rq'), 'utf8');
  return template.replace('{{NAMES}}', ids.map((id) => `wd:${id}`).join(' '));
}

/** A data.gov.sg dataset's current download (a short-lived signed URL). */
async function dataGovSg(datasetId: string): Promise<Buffer> {
  const poll = await download(
    `https://api-open.data.gov.sg/v1/public/api/datasets/${datasetId}/poll-download`,
  );
  const { data } = JSON.parse(poll.toString('utf8')) as {
    data?: { url?: string };
  };
  if (typeof data?.url !== 'string') throw new Error('no download URL');
  return download(data.url);
}

async function bytesOf(
  sourceId: string,
  file: SourceFile,
  dir: string,
): Promise<Buffer> {
  if (file.url !== undefined) return download(file.url);
  if (file.datagovsg !== undefined) return dataGovSg(file.datagovsg);
  if (file.query !== undefined) {
    return sparql(readFileSync(join(OPENDATA, 'queries', file.query), 'utf8'));
  }
  if (file.labelsOf !== undefined) {
    return sparql(labelsQuery(readFileSync(join(dir, file.labelsOf))));
  }
  throw new Error(`${sourceId}/${file.name}: no way to fetch it`);
}

const sources = readSources();
let failures = 0;
for (const source of sources.sources) {
  const dir = join(RAW, source.id);
  mkdirSync(dir, { recursive: true });
  for (const file of source.files) {
    const target = join(dir, file.name);
    const kept = existsSync(target) ? readFileSync(target) : null;
    if (!update && kept !== null && sha256(kept) === file.sha256) {
      console.log(`ok       ${source.id}/${file.name}`);
      continue;
    }
    if (update && kept !== null && file.sha256 === null) {
      // Downloaded by an update that stopped before recording it.
      file.sha256 = sha256(kept);
      file.bytes = kept.length;
      file.retrieved = today;
      writeSources(sources);
      console.log(`recorded ${source.id}/${file.name} (downloaded earlier)`);
      continue;
    }
    const bytes = await withRetries(`${source.id}/${file.name}`, () =>
      bytesOf(source.id, file, dir),
    );
    writeFileSync(target, bytes);
    const actual = sha256(bytes);
    if (update) {
      if (actual !== file.sha256) file.retrieved = today;
      file.sha256 = actual;
      file.bytes = bytes.length;
      // Saved after each file, so a later failure keeps what was recorded.
      writeSources(sources);
      console.log(`recorded ${source.id}/${file.name} ${actual}`);
    } else if (actual === file.sha256) {
      console.log(`fetched  ${source.id}/${file.name}`);
    } else {
      failures += 1;
      console.log(
        `CHANGED  ${source.id}/${file.name}: expected ${String(file.sha256)}, got ${actual} (rerun with --update and review)`,
      );
    }
  }
}

if (failures > 0) {
  throw new Error(
    `${failures.toString()} file(s) differ from the pinned checksums`,
  );
}
console.log(update ? 'Checksums recorded.' : 'All open-data files verified.');
