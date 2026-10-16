/**
 * Downloads the model files listed in models.json into public/models/ and
 * verifies each one against its pinned size and SHA-256. Development time
 * only: the extension itself never downloads models.
 *
 * Usage: npm run models:fetch
 */
import { createHash } from 'node:crypto';
import {
  createReadStream,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import manifest from './models.json' with { type: 'json' };

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const modelsDir = join(root, 'public', 'models');

interface ModelFile {
  path: string;
  size: number;
  sha256: string;
}

function sha256OfFile(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    createReadStream(file)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', reject)
      .on('end', () => {
        resolve(hash.digest('hex'));
      });
  });
}

async function fetchFile(
  id: string,
  revision: string,
  file: ModelFile,
): Promise<void> {
  const target = join(modelsDir, id, file.path);
  if (existsSync(target) && (await sha256OfFile(target)) === file.sha256) {
    console.log(`ok       ${id}/${file.path}`);
    return;
  }
  const url = `https://huggingface.co/${id}/resolve/${revision}/${file.path}`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`download failed (${response.status.toString()}): ${url}`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (bytes.length !== file.size || actual !== file.sha256) {
    throw new Error(
      `checksum mismatch for ${id}/${file.path}: expected ${file.sha256} (${file.size.toString()} bytes), got ${actual} (${bytes.length.toString()} bytes)`,
    );
  }
  mkdirSync(dirname(target), { recursive: true });
  // Write next to the target first, so a partial file never looks complete.
  const partial = `${target}.partial`;
  await writeFile(partial, bytes);
  rmSync(target, { force: true });
  renameSync(partial, target);
  console.log(`fetched  ${id}/${file.path}`);
}

for (const model of manifest.models) {
  for (const file of model.files) {
    await fetchFile(model.id, model.revision, file);
  }
}
console.log('All model files verified.');
