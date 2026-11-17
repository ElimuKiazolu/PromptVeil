/**
 * Writes the stand-in word lists to public/data/ (see scripts/wordlists.ts)
 * and reports each file's size, counts, and inherited or missing fields.
 *
 * Run after upgrading @faker-js/faker (a test fails while the committed
 * files differ from what the installed version gives):
 *
 *   npm run generate:wordlists
 */
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { allLocales } from '@faker-js/faker';
import { buildWordLists } from './wordlists.ts';

/** NFR4: all locale lists together. */
const MAX_TOTAL_BYTES = 5 * 1024 * 1024;

const OUTPUT = fileURLToPath(new URL('../public/data/', import.meta.url));

const build = buildWordLists(allLocales);
const total = build.files.reduce(
  (sum, file) => sum + Buffer.byteLength(file.contents),
  0,
);
if (total > MAX_TOTAL_BYTES) {
  throw new Error(`word lists are ${total.toString()} bytes, over 5 MB`);
}

mkdirSync(OUTPUT, { recursive: true });
for (const name of readdirSync(OUTPUT)) {
  if (name.endsWith('.json')) rmSync(join(OUTPUT, name));
}
for (const file of build.files) {
  writeFileSync(join(OUTPUT, file.name), file.contents);
}

const kb = (bytes: number): string => `${(bytes / 1024).toFixed(1)} kB`;
for (const report of build.locales) {
  const counts = Object.entries(report.counts)
    .map(([name, count]) => `${name} ${count.toString()}`)
    .join(', ');
  const inherited = Object.entries(report.inherited)
    .map(([name, from]) => `${name} from ${from}`)
    .join(', ');
  process.stdout.write(
    `${report.locale.padEnd(6)} ${kb(report.bytes).padStart(9)}  ${counts}` +
      (inherited === '' ? '' : `\n         inherited: ${inherited}`) +
      (report.missing.length === 0
        ? ''
        : `\n         missing: ${report.missing.join(', ')}`) +
      '\n',
  );
}
process.stdout.write(
  `name index ${kb(build.indexBytes)}; total ${kb(total)} in ${build.files.length.toString()} files\n`,
);
