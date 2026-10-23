/**
 * Builds the detection module (src/core/detect/bundle.ts) as one ES module,
 * `detection.js`, which the ChatGPT content script imports at run time. WXT
 * builds content scripts as classic scripts only, so this module gets its
 * own library build; wxt.config.ts adds the result to the output as a
 * generated public file, so build and zip both include it.
 *
 * libphonenumber's metadata ships as a large object literal, which costs
 * far more to evaluate than the same data as JSON text; it is emitted as
 * JSON.parse("…") instead, keeping the module cheap to import.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { build, type Plugin } from 'vite';

const ENTRY = fileURLToPath(
  new URL('../src/core/detect/bundle.ts', import.meta.url),
);
const PHONE_METADATA_MODULE = /libphonenumber-js[\\/]metadata\.max\.json\.js$/u;
const PHONE_METADATA_JSON = fileURLToPath(
  new URL(
    '../node_modules/libphonenumber-js/metadata.max.json',
    import.meta.url,
  ),
);

/** Serves the phone metadata module as JSON text parsed once on import. */
function phoneMetadataAsJson(): Plugin {
  return {
    name: 'promptveil:phone-metadata-as-json',
    load(id) {
      if (!PHONE_METADATA_MODULE.test(id)) return null;
      const json = readFileSync(PHONE_METADATA_JSON, 'utf8');
      // Parse once to fail the build on malformed metadata.
      JSON.parse(json);
      return `export default JSON.parse(${JSON.stringify(json)});`;
    },
  };
}

interface OutputItem {
  type: string;
  isEntry?: boolean;
  code?: string;
}

function isOutputList(value: unknown): value is { output: OutputItem[] } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'output' in value &&
    Array.isArray(value.output)
  );
}

/** The module's code. */
export async function buildDetectionModule(mode: string): Promise<string> {
  const result: unknown = await build({
    configFile: false,
    logLevel: 'warn',
    mode,
    plugins: [phoneMetadataAsJson()],
    define: { 'process.env.NODE_ENV': JSON.stringify('production') },
    build: {
      write: false,
      target: 'esnext',
      minify: true,
      lib: { entry: ENTRY, formats: ['es'], fileName: 'detection' },
      rollupOptions: { output: { inlineDynamicImports: true } },
    },
  });
  const outputs: readonly unknown[] = Array.isArray(result) ? result : [result];
  for (const output of outputs) {
    if (!isOutputList(output)) continue;
    const entry = output.output.find(
      (item) => item.type === 'chunk' && item.isEntry === true,
    );
    if (entry?.code !== undefined) return entry.code;
  }
  throw new Error('detection module build produced no entry chunk');
}
