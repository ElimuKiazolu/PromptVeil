/**
 * Browser checks: the extension in headless Chrome against the local
 * chatgpt.com copy (never the real site). See tests/e2e/README.md.
 *
 *   npm run e2e                      build, then every check in order
 *   npm run e2e -- --shuffle <seed>  every check in a seeded random order
 *   npm run e2e -- --only a,b        only these checks (ids)
 *   npm run e2e -- --no-build        reuse .output/chrome-mv3-e2e
 *   npm run e2e -- --list            print the checks
 *
 * The audit always runs last. Exit code 0 only when every check passed.
 */
import { auditCheck } from './checks/audit.ts';
import type { Check } from './checks/common.ts';
import { maskingChecks } from './checks/masking.ts';
import { noticeChecks } from './checks/notices.ts';
import { sessionChecks } from './checks/session.ts';
import { timingChecks } from './checks/timing.ts';
import { writeChecks } from './checks/writes.ts';
import { buildForE2e, e2eExtensionDir } from './build.ts';
import { launch } from './support/browser.ts';
import { startSite } from './support/site.ts';

const CHECKS: readonly Check[] = [
  ...sessionChecks,
  ...maskingChecks,
  ...timingChecks,
  ...writeChecks,
  ...noticeChecks,
];

interface Options {
  readonly seed: number | null;
  readonly only: ReadonlySet<string> | null;
  readonly build: boolean;
  readonly list: boolean;
}

function parseOptions(args: readonly string[]): Options {
  const valueOf = (flag: string): string | null => {
    const at = args.indexOf(flag);
    if (at < 0) return null;
    const value = args[at + 1];
    if (value === undefined) throw new Error(`${flag} needs a value`);
    return value;
  };
  const seedText = valueOf('--shuffle');
  const seed = seedText === null ? null : Number(seedText);
  if (seed !== null && !Number.isInteger(seed))
    throw new Error('--shuffle needs an integer');
  const onlyText = valueOf('--only');
  const only = onlyText === null ? null : new Set(onlyText.split(','));
  if (only) {
    const unknown = [...only].filter(
      (id) => id !== auditCheck.id && !CHECKS.some((c) => c.id === id),
    );
    if (unknown.length > 0)
      throw new Error(`unknown checks: ${unknown.join(', ')}`);
  }
  return {
    seed,
    only,
    build: !args.includes('--no-build'),
    list: args.includes('--list'),
  };
}

/** Seeded Fisher–Yates (linear congruential generator). */
function shuffled<T>(items: readonly T[], seed: number): T[] {
  const out = [...items];
  let state = seed >>> 0;
  const next = (): number => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(next() * (i + 1));
    const a = out[i];
    const b = out[j];
    if (a === undefined || b === undefined) continue;
    out[i] = b;
    out[j] = a;
  }
  return out;
}

const options = parseOptions(process.argv.slice(2));
if (options.list) {
  for (const check of [...CHECKS, auditCheck]) {
    console.log(
      `${check.id.padEnd(24)} ${check.phase.padEnd(5)} ${check.title}`,
    );
  }
  process.exit(0);
}

const selected = CHECKS.filter((c) => options.only?.has(c.id) ?? true);
const order =
  options.seed === null ? selected : shuffled(selected, options.seed);
if (options.build) {
  console.log('building .output/chrome-mv3-e2e …');
  await buildForE2e();
}

const site = await startSite();
const harness = await launch(site, e2eExtensionDir());
const results: { check: Check; ok: boolean; ms: number; note: string }[] = [];
try {
  for (const check of [...order, auditCheck]) {
    const started = Date.now();
    let ok = true;
    let note = '';
    try {
      note = (await check.run(harness)) ?? '';
    } catch (error) {
      ok = false;
      note = error instanceof Error ? error.message : String(error);
    }
    const ms = Date.now() - started;
    results.push({ check, ok, ms, note });
    console.log(
      `${ok ? 'PASS' : 'FAIL'} ${check.id} (${(ms / 1000).toFixed(1)} s)${note ? ` — ${note}` : ''}`,
    );
  }
} finally {
  await harness.close();
  await site.close();
}

const failed = results.filter((r) => !r.ok);
console.log(
  `\n${(results.length - failed.length).toString()}/${results.length.toString()} passed · order: ${
    options.seed === null
      ? 'normal'
      : `shuffled (seed ${options.seed.toString()})`
  }`,
);
process.exit(failed.length === 0 ? 0 : 1);
