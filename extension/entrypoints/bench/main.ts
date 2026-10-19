/**
 * Dev-only benchmark page (benchmark builds only). Each button runs one
 * configuration, either in the offscreen document (the production design,
 * TR-N1) or in a worker started by this page (to isolate offscreen problems).
 * Progress, results and failures, with the stage they happened in, are shown
 * here so they can be screenshotted.
 */
import '@/src/ui/theme.css';
import modelManifest from '@/scripts/models.json';
import {
  clearBreadcrumb,
  describeBreadcrumb,
  readBreadcrumb,
  saveBreadcrumb,
  type StorageLike,
} from '@/src/dev/bench/breadcrumb.ts';
import {
  BENCH_OFFSCREEN_PORT,
  BENCH_PORT,
  MODEL_ID,
  WARM_RUNS,
  describeConfig,
  describeStage,
  errorMessage,
  type BenchConfig,
  type BenchPath,
  type BenchResult,
  type BenchStage,
  type StageDetail,
} from '@/src/dev/bench/protocol.ts';
import {
  BenchFailure,
  buildRequest,
  measureMemory,
  portChannel,
  requestOffscreen,
  runBench,
  workerChannel,
  type HostedResult,
} from '@/src/dev/bench/session.ts';
import { checkTargets } from '@/src/dev/bench/targets.ts';
import {
  BENCH_WORD_TARGETS,
  benchTexts,
  wordCount,
} from '@/src/dev/bench/texts.ts';

/** A step that sends nothing for this long has stalled (cold loads on slow laptops are long). */
const STALL_MS = 180_000;
const OFFSCREEN_TIMEOUT_MS = 30_000;

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

/** localStorage, or why it is unavailable (the accessor itself can throw). */
function openStorage(): StorageLike | string {
  try {
    return window.localStorage;
  } catch (error) {
    return errorMessage(error);
  }
}

const lastError = (): string | undefined => browser.runtime.lastError?.message;

/** null when a WebGPU adapter is available, otherwise the reason it is not. */
async function webGpuUnavailable(): Promise<string | null> {
  const gpu: unknown = Reflect.get(navigator, 'gpu');
  if (typeof gpu !== 'object' || gpu === null) {
    return 'WebGPU is not available in this browser';
  }
  const requestAdapter: unknown = Reflect.get(gpu, 'requestAdapter');
  if (typeof requestAdapter !== 'function') {
    return 'WebGPU is not available in this browser';
  }
  try {
    const adapter: unknown = await Reflect.apply(requestAdapter, gpu, []);
    return adapter ? null : 'no WebGPU adapter (GPU blocked or disabled)';
  } catch (error) {
    return `WebGPU adapter request failed: ${errorMessage(error)}`;
  }
}

function startWorker(): Worker {
  return new Worker(new URL('../../src/dev/bench/worker.ts', import.meta.url), {
    type: 'module',
  });
}

function renderResult(result: BenchResult): HTMLElement {
  const section = el(
    'section',
    'mt-6 rounded-lg border border-sage bg-white p-4',
  );
  section.append(
    el(
      'h2',
      'text-lg font-medium text-spruce',
      describeConfig(result.config, result.path),
    ),
  );
  section.append(
    el(
      'p',
      'mt-1 text-sm tabular-nums',
      `Backend: ${result.config.device} · threads used: ${result.threadsUsed.toString()} · worker cross-origin isolated: ${result.crossOriginIsolated ? 'yes' : 'no'} · load: tokenizer ${result.tokenizerLoadMs.toFixed(0)} ms + model ${result.modelLoadMs.toFixed(0)} ms`,
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

  const memoryBytes = 'bytes' in result.memory ? result.memory.bytes : null;
  if ('unavailable' in result.memory) {
    section.append(
      el(
        'p',
        'mt-1 text-sm',
        `Memory not measured in the page: ${result.memory.unavailable}.`,
      ),
    );
  }
  const checks = el('table', 'mt-3 w-full text-sm tabular-nums');
  for (const check of checkTargets({
    loadMs: result.loadMs,
    p95At300WordsMs: result.timings[300].p95,
    modelBytes,
    memoryBytes,
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

function renderFailure(
  title: string,
  stage: string,
  message: string,
): HTMLElement {
  const section = el(
    'section',
    'mt-6 rounded-lg border border-brick bg-white p-4',
  );
  section.append(
    el('h2', 'text-lg font-medium text-brick', `Failed: ${title}`),
  );
  section.append(el('p', 'mt-1 text-sm', `Stage: ${stage}`));
  section.append(el('p', 'mt-1 text-sm break-words', message));
  return section;
}

function start(): void {
  const app = document.getElementById('app');
  if (!app) throw new Error('benchmark root is missing');
  const texts = benchTexts();
  const storage = openStorage();
  const threads = Math.max(1, navigator.hardwareConcurrency);

  app.append(
    el('h1', 'text-xl font-medium text-spruce', 'PromptVeil NER benchmark'),
    el(
      'p',
      'mt-1 text-sm',
      `Model ${MODEL_ID} (q8, ${(modelBytes / (1024 * 1024)).toFixed(1)} MB). Inputs: ${BENCH_WORD_TARGETS.map((s) => wordCount(texts[s]).toString()).join(' / ')} words from fictional identities; one warm-up then ${WARM_RUNS.toString()} runs each. Benchmark builds only.`,
    ),
    el(
      'p',
      'mt-1 text-sm',
      `This build: cross-origin isolated ${crossOriginIsolated ? 'yes' : 'no'} · CPU threads ${threads.toString()}.`,
    ),
  );

  const results = el('div', '');
  const storageNote = el('p', 'mt-3 text-sm text-brick');
  app.append(storageNote);
  if (typeof storage === 'string') {
    storageNote.textContent = `Progress cannot be saved (${storage}), so a killed tab cannot be explained after reload.`;
  } else {
    const crumb = readBreadcrumb(storage);
    if (crumb) {
      results.append(
        renderFailure(
          describeConfig(crumb.config, crumb.path),
          describeStage(crumb.stage, crumb.detail),
          describeBreadcrumb(crumb),
        ),
      );
      clearBreadcrumb(storage);
    }
  }

  const status = el('p', 'mt-4 text-sm tabular-nums', 'Ready.');
  const buttons: HTMLButtonElement[] = [];
  const unavailable = new Map<HTMLButtonElement, string>();
  let busy = false;

  const setBusy = (value: boolean): void => {
    busy = value;
    for (const button of buttons) {
      button.disabled = value || unavailable.has(button);
    }
  };
  const markUnavailable = (button: HTMLButtonElement, reason: string): void => {
    unavailable.set(button, reason);
    button.disabled = true;
    button.title = reason;
    button.textContent = `${button.textContent} (unavailable)`;
  };

  const run = async (path: BenchPath, config: BenchConfig): Promise<void> => {
    if (busy) return;
    setBusy(true);
    const title = describeConfig(config, path);
    let stage: BenchStage =
      path === 'offscreen' ? 'creating-offscreen' : 'starting-worker';
    let stageText = describeStage(stage);
    let stageStart = performance.now();
    const showStatus = (): void => {
      const seconds = (performance.now() - stageStart) / 1000;
      status.textContent = `${title}: ${stageText} · ${seconds.toFixed(0)} s`;
    };
    const ticker = window.setInterval(showStatus, 1000);
    const onStage = (next: BenchStage, detail?: StageDetail): void => {
      stage = next;
      stageText = describeStage(next, detail);
      stageStart = performance.now();
      if (typeof storage !== 'string') {
        try {
          saveBreadcrumb(storage, {
            path,
            config,
            stage: next,
            ...(detail ? { detail } : {}),
            at: Date.now(),
          });
        } catch (error) {
          storageNote.textContent = `Progress could not be saved (${errorMessage(error)}), so a killed tab cannot be explained after reload.`;
        }
      }
      showStatus();
    };

    try {
      const request = buildRequest(config, browser.runtime.getURL('/'), texts);
      let hosted: HostedResult;
      if (path === 'offscreen') {
        onStage('creating-offscreen');
        await requestOffscreen(
          browser.runtime.connect({ name: BENCH_OFFSCREEN_PORT }),
          lastError,
          OFFSCREEN_TIMEOUT_MS,
        );
        hosted = await runBench({
          open: (events) =>
            portChannel(
              browser.runtime.connect({ name: BENCH_PORT }),
              events,
              lastError,
            ),
          request,
          onStage,
          stallMs: STALL_MS,
        });
      } else {
        hosted = await runBench({
          open: (events) =>
            workerChannel(
              startWorker(),
              (message) => {
                events.message(message);
              },
              measureMemory,
            ),
          request,
          onStage,
          stallMs: STALL_MS,
        });
      }
      results.prepend(
        renderResult({ ...hosted.result, path, memory: hosted.memory }),
      );
      status.textContent = `${title}: done.`;
    } catch (error) {
      const failedStage = error instanceof BenchFailure ? error.stage : stage;
      results.prepend(
        renderFailure(title, describeStage(failedStage), errorMessage(error)),
      );
      status.textContent = `${title}: failed during ${describeStage(failedStage)}.`;
    } finally {
      window.clearInterval(ticker);
      if (typeof storage !== 'string') clearBreadcrumb(storage);
      setBusy(false);
    }
  };

  const groups: { path: BenchPath; heading: string; note: string }[] = [
    {
      path: 'offscreen',
      heading: 'Offscreen document',
      note: 'The production design: the background creates the offscreen document, which starts the worker.',
    },
    {
      path: 'direct',
      heading: 'Direct worker',
      note: 'No offscreen document: this page starts the same worker itself.',
    },
  ];
  const gpuButtons: HTMLButtonElement[] = [];
  for (const group of groups) {
    const section = el('section', 'mt-4');
    section.append(
      el('h2', 'text-base font-medium text-spruce', group.heading),
      el('p', 'text-sm', group.note),
    );
    const row = el('div', 'mt-2 flex flex-wrap gap-2');
    const configs: { label: string; config: BenchConfig }[] = [
      { label: 'Single thread', config: { device: 'wasm', threads: 1 } },
      { label: 'Multi-thread', config: { device: 'wasm', threads } },
      { label: 'WebGPU', config: { device: 'webgpu', threads: 1 } },
    ];
    for (const { label, config } of configs) {
      const button = el(
        'button',
        'rounded-md border border-spruce px-4 py-2 text-spruce disabled:opacity-50',
        label,
      );
      button.type = 'button';
      button.addEventListener('click', () => {
        void run(group.path, config);
      });
      buttons.push(button);
      row.append(button);
      if (config.device === 'wasm' && config.threads > 1) {
        if (!crossOriginIsolated) {
          markUnavailable(
            button,
            'needs the cross-origin isolated build (npm run bench:build)',
          );
        } else if (threads === 1) {
          markUnavailable(button, 'this device reports one CPU thread');
        }
      }
      if (config.device === 'webgpu') gpuButtons.push(button);
    }
    section.append(row);
    app.append(section);
  }
  app.append(status, results);

  void webGpuUnavailable().then((reason) => {
    if (reason === null) return;
    for (const button of gpuButtons) markUnavailable(button, reason);
    setBusy(busy);
  });

  // Anything that escapes the run handlers is still shown, not just logged.
  window.addEventListener('error', (event) => {
    results.prepend(renderFailure('page script', 'page', event.message));
  });
  window.addEventListener('unhandledrejection', (event) => {
    results.prepend(
      renderFailure('page script', 'page', errorMessage(event.reason)),
    );
  });
}

start();
