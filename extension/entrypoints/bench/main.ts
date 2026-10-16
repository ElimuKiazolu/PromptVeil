/**
 * Dev-only benchmark page: runs the NER timing in the offscreen document and
 * shows the results here, so they can be screenshotted.
 */
import '@/src/ui/theme.css';
import modelManifest from '@/scripts/models.json';
import {
  BENCH_PORT,
  MODEL_ID,
  WARM_RUNS,
  type BenchConfig,
  type BenchMessage,
  type BenchResult,
} from '@/src/dev/bench/protocol.ts';
import { checkTargets } from '@/src/dev/bench/targets.ts';
import {
  BENCH_WORD_TARGETS,
  benchTexts,
  wordCount,
} from '@/src/dev/bench/texts.ts';

const OFFSCREEN_PATH = '/offscreen-bench.html';

const modelBytes =
  modelManifest.models
    .find((m) => m.id === MODEL_ID)
    ?.files.find((f) => f.path.endsWith('.onnx'))?.size ?? 0;

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  text = '',
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = text;
  return node;
}

async function ensureOffscreen(): Promise<void> {
  const contexts = await browser.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
  });
  if (contexts.length > 0) return;
  await browser.offscreen.createDocument({
    // A dev-only page, so it is resolved from this page rather than the typed
    // list of production files.
    url: new URL(OFFSCREEN_PATH, location.href).href,
    reasons: ['WORKERS'],
    justification: 'Development-only timing of the on-device NER model.',
  });
}

function runOnce(
  config: BenchConfig,
  onProgress: (step: string) => void,
): Promise<BenchResult> {
  return new Promise((resolve, reject) => {
    const port = browser.runtime.connect({ name: BENCH_PORT });
    port.onMessage.addListener((message: BenchMessage) => {
      if (message.type === 'progress') onProgress(message.step);
      else if (message.type === 'result') {
        port.disconnect();
        resolve(message.result);
      } else {
        port.disconnect();
        reject(new Error(message.message));
      }
    });
    port.postMessage(config);
  });
}

function configLabel(config: BenchConfig): string {
  return config.device === 'webgpu'
    ? 'WebGPU'
    : `WASM, ${config.threads.toString()} thread${config.threads === 1 ? '' : 's'}`;
}

function renderResult(result: BenchResult): HTMLElement {
  const section = el(
    'section',
    'mt-6 rounded-lg border border-sage bg-white p-4',
  );
  section.append(
    el('h2', 'text-lg font-medium text-spruce', configLabel(result.config)),
  );
  section.append(
    el(
      'p',
      'mt-1 text-sm',
      `Backend: ${result.config.device} · threads used: ${result.threadsUsed.toString()} · cross-origin isolated: ${result.crossOriginIsolated ? 'yes' : 'no'}`,
    ),
  );

  const timings = el('table', 'mt-3 w-full text-sm tabular-nums');
  const head = el('tr', 'text-left text-spruce');
  for (const label of [
    'Input',
    'Runs',
    'p50 (ms)',
    'p95 (ms)',
    'min (ms)',
    'max (ms)',
  ]) {
    head.append(el('th', 'pr-4 font-medium', label));
  }
  timings.append(head);
  for (const size of BENCH_WORD_TARGETS) {
    const t = result.timings[size];
    const row = el('tr', '');
    for (const cell of [
      `${size.toString()} words`,
      t.runs.toString(),
      t.p50.toFixed(0),
      t.p95.toFixed(0),
      t.min.toFixed(0),
      t.max.toFixed(0),
    ]) {
      row.append(el('td', 'pr-4', cell));
    }
    timings.append(row);
  }
  section.append(timings);

  const entities = Object.entries(result.entities300)
    .map(([type, count]) => `${type} ${count.toString()}`)
    .join(', ');
  section.append(
    el(
      'p',
      'mt-3 text-sm',
      `Entities found in the 300-word input: ${entities || 'none'}`,
    ),
  );

  const checks = el('table', 'mt-3 w-full text-sm tabular-nums');
  for (const check of checkTargets({
    loadMs: result.loadMs,
    p95At300WordsMs: result.timings[300].p95,
    modelBytes,
    memoryBytes: result.memoryBytes,
  })) {
    const row = el('tr', '');
    row.append(el('td', 'pr-4', check.name));
    row.append(el('td', 'pr-4', check.target));
    row.append(el('td', 'pr-4', check.measured));
    const verdict =
      check.pass === null ? 'see Task Manager' : check.pass ? 'PASS' : 'FAIL';
    const colour =
      check.pass === null
        ? 'text-graphite'
        : check.pass
          ? 'text-spruce'
          : 'text-brick';
    row.append(el('td', `font-medium ${colour}`, verdict));
    checks.append(row);
  }
  section.append(checks);
  return section;
}

function start(): void {
  const app = document.getElementById('app');
  if (!app) throw new Error('benchmark root is missing');
  const texts = benchTexts();
  app.append(
    el('h1', 'text-xl font-medium text-spruce', 'PromptVeil NER benchmark'),
  );
  app.append(
    el(
      'p',
      'mt-1 text-sm',
      `Model ${MODEL_ID} (q8, ${(modelBytes / (1024 * 1024)).toFixed(1)} MB). Inputs: ${BENCH_WORD_TARGETS.map((s) => wordCount(texts[s]).toString()).join(' / ')} words from fictional identities; one warm-up then ${WARM_RUNS.toString()} runs each. Development build only.`,
    ),
  );

  const controls = el('div', 'mt-4 flex flex-wrap gap-2');
  const runButton = el(
    'button',
    'rounded-md bg-spruce px-4 py-2 text-mist disabled:opacity-50',
    'Run benchmark',
  );
  const gpuButton = el(
    'button',
    'rounded-md border border-spruce px-4 py-2 text-spruce disabled:opacity-50',
    'Try WebGPU',
  );
  const status = el('p', 'mt-3 text-sm', 'Ready.');
  const results = el('div', '');
  controls.append(runButton);
  if ('gpu' in navigator) controls.append(gpuButton);
  app.append(controls, status, results);

  const runAll = async (configs: BenchConfig[]): Promise<void> => {
    runButton.disabled = true;
    gpuButton.disabled = true;
    try {
      await ensureOffscreen();
      for (const config of configs) {
        const result = await runOnce(config, (step) => {
          status.textContent = `${configLabel(config)}: ${step}`;
        });
        results.append(renderResult(result));
      }
      status.textContent = 'Done.';
    } catch (error) {
      status.textContent = `Failed: ${error instanceof Error ? error.message : 'unknown error'}`;
    } finally {
      runButton.disabled = false;
      gpuButton.disabled = false;
    }
  };

  runButton.addEventListener('click', () => {
    void runAll([
      { device: 'wasm', threads: 1 },
      { device: 'wasm', threads: Math.max(1, navigator.hardwareConcurrency) },
    ]);
  });
  gpuButton.addEventListener('click', () => {
    void runAll([{ device: 'webgpu', threads: 1 }]);
  });
}

start();
