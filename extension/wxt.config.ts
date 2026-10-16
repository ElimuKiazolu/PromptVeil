import { fileURLToPath } from 'node:url';
import { defineConfig } from 'wxt';
import tailwindcss from '@tailwindcss/vite';

/** Pages that exist only in development builds (the NER benchmark). */
const DEV_ONLY_ENTRYPOINTS = new Set(['bench', 'offscreen-bench']);

/**
 * ONNX Runtime WASM files used by Transformers.js in the browser. Copied from
 * node_modules into the build, so nothing is fetched at runtime.
 */
const ORT_FILES = [
  'ort-wasm-simd-threaded.asyncify.mjs',
  'ort-wasm-simd-threaded.asyncify.wasm',
];

const isProduction = (mode: string): boolean => mode === 'production';

export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  // Chrome ignores the flag used to auto-load extensions, so loading is manual:
  // run `npm run dev`, then "Load unpacked" on .output/chrome-mv3-dev once.
  webExt: { disabled: true },
  vite: () => ({
    plugins: [tailwindcss()],
  }),
  hooks: {
    'entrypoints:resolved': (wxt, entrypoints) => {
      if (!isProduction(wxt.config.mode)) return;
      for (let i = entrypoints.length - 1; i >= 0; i -= 1) {
        const entrypoint = entrypoints[i];
        if (entrypoint && DEV_ONLY_ENTRYPOINTS.has(entrypoint.name)) {
          entrypoints.splice(i, 1);
        }
      }
    },
    'build:publicAssets': (wxt, files) => {
      if (isProduction(wxt.config.mode)) {
        // Model files stay out of production builds until the model's
        // licence is decided (see the licensing decision for P7).
        for (let i = files.length - 1; i >= 0; i -= 1) {
          // Paths use the platform separator (backslashes on Windows).
          const dest = files[i]?.relativeDest.replace(/\\/g, '/') ?? '';
          if (dest.startsWith('models/')) files.splice(i, 1);
        }
        return;
      }
      for (const name of ORT_FILES) {
        files.push({
          absoluteSrc: fileURLToPath(
            new URL(
              `node_modules/onnxruntime-web/dist/${name}`,
              import.meta.url,
            ),
          ),
          relativeDest: `ort/${name}`,
        });
      }
    },
  },
  manifest: ({ mode }) => ({
    name: 'PromptVeil',
    version: '0.1.0',
    description:
      'Masks personal data in prompts to AI chatbots with realistic stand-ins and restores it in the replies. Runs entirely on your device.',
    permissions: ['storage', 'unlimitedStorage', 'offscreen'],
    host_permissions: [
      'https://chatgpt.com/*',
      'https://gemini.google.com/*',
      'https://claude.ai/*',
    ],
    content_security_policy: {
      extension_pages:
        "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'",
    },
    // Development only: cross-origin isolation lets the benchmark measure
    // multi-threaded WASM. Production decides this with the model (P7).
    ...(isProduction(mode)
      ? {}
      : {
          cross_origin_embedder_policy: { value: 'require-corp' },
          cross_origin_opener_policy: { value: 'same-origin' },
        }),
  }),
});
