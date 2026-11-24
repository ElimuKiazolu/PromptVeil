/**
 * Builds the extension for the browser checks: a development build (dev
 * logs on, as `npm run dev` produces) written to .output/chrome-mv3-e2e, next
 * to, never over, the live-test build in .output/chrome-mv3-dev.
 */
import { fileURLToPath, pathToFileURL } from 'node:url';

export const E2E_OUT_DIR = 'chrome-mv3-e2e';
const ROOT = fileURLToPath(new URL('../../', import.meta.url));

export function e2eExtensionDir(): string {
  return fileURLToPath(
    new URL(`../../.output/${E2E_OUT_DIR}/`, import.meta.url),
  );
}

export async function buildForE2e(): Promise<void> {
  // Vite reads NODE_ENV when the build starts: development keeps
  // import.meta.env.DEV (dev logs, the dev-only worker helpers) on.
  process.env.NODE_ENV = 'development';
  const { build } = await import('wxt');
  await build({ root: ROOT, mode: 'development', outDirTemplate: E2E_OUT_DIR });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  await buildForE2e();
}
