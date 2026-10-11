import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Resvg } from '@resvg/resvg-js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const brandDir = join(root, 'assets', 'brand');
const outDir = join(root, 'public', 'icon');

// The simplified mark has thicker strokes and larger dots so it stays legible
// at toolbar sizes.
const sizes = [
  { px: 16, source: 'icon-small.svg' },
  { px: 32, source: 'icon-small.svg' },
  { px: 48, source: 'icon-full.svg' },
  { px: 128, source: 'icon-full.svg' },
] as const;

mkdirSync(outDir, { recursive: true });

for (const { px, source } of sizes) {
  const svg = readFileSync(join(brandDir, source), 'utf8');
  const png = new Resvg(svg, { fitTo: { mode: 'width', value: px } })
    .render()
    .asPng();
  writeFileSync(join(outDir, `${px.toString()}.png`), png);
  console.log(`icon/${px.toString()}.png (${source})`);
}
