/**
 * Send timings (P6.1, P6.2): warm sends in one conversation, first sends in
 * new chats, and sends with a stopped service worker. Each send carries
 * seven new values; every one must reach the site masked and come back
 * restored. Numbers come from the dev log (pipeline.timing, send.masked).
 */
import { field, type Harness, type Tab } from '../support/browser.ts';
import { generated, real } from '../support/values.ts';
import { assertNoReal, stats, withTabs, type Check } from './common.ts';

interface Timings {
  pipeline: number[];
  commit: number[];
  generate: number[];
  send: number[];
}

function sevenValues(label: string): string[] {
  return [
    real(generated.email(label)),
    real(generated.ukMobile(label)),
    real(generated.nino(label)),
    real(generated.cpf(label)),
    real(generated.iban(label)),
    real(generated.ssn(label)),
    real(generated.publicIpv4(label)),
  ];
}

function prompt(v: readonly string[]): string {
  return `Email ${v[0] ?? ''}, phone ${v[1] ?? ''}, NI ${v[2] ?? ''}, CPF ${v[3] ?? ''}, IBAN ${v[4] ?? ''}, SSN ${v[5] ?? ''}, server ${v[6] ?? ''}.`;
}

async function timedSend(
  h: Harness,
  tab: Tab,
  label: string,
  newChat: boolean,
  into: Timings,
): Promise<void> {
  const values = sevenValues(label);
  const mark = h.logs.mark();
  const sent = await tab.send(prompt(values), { newChat });
  assertNoReal(sent.received, values, `send ${label}`);
  const pipeline = await h.logs.waitFor(
    / pipeline\.timing /,
    mark,
    10_000,
    'page',
  );
  const masked = await h.logs.waitFor(/ send\.masked /, mark, 10_000, 'page');
  const push = (list: number[], value: number | null): void => {
    if (value !== null) list.push(value);
  };
  push(into.pipeline, field(pipeline.text, 'total'));
  push(into.commit, field(pipeline.text, 'commit'));
  push(into.generate, field(pipeline.text, 'generate'));
  push(into.send, field(masked.text, 'total'));
  await tab.waitForText(values);
}

function report(t: Timings): string {
  return `n=${t.send.length.toString()} median/p95 ms: generate ${stats(t.generate)}, commit ${stats(t.commit)}, pipeline ${stats(t.pipeline)}, send ${stats(t.send)}`;
}

const empty = (): Timings => ({
  pipeline: [],
  commit: [],
  generate: [],
  send: [],
});

export const timingChecks: readonly Check[] = [
  {
    id: 'timing-warm',
    title: 'timing: 30 warm sends of 7 new values in one conversation',
    phase: 'P6.2',
    run: (h) =>
      withTabs(async (track) => {
        const tab = track(await h.openTab());
        await timedSend(h, tab, 'warm start', true, empty());
        const t = empty();
        for (let i = 0; i < 30; i += 1) {
          await timedSend(h, tab, `warm ${i.toString()}`, false, t);
        }
        return report(t);
      }),
  },
  {
    id: 'timing-new-chat',
    title: 'timing: 10 first sends in new chats',
    phase: 'P6.2',
    run: (h) =>
      withTabs(async (track) => {
        const tab = track(await h.openTab());
        const t = empty();
        for (let i = 0; i < 10; i += 1) {
          await timedSend(h, tab, `first ${i.toString()}`, true, t);
        }
        return report(t);
      }),
  },
  {
    id: 'timing-cold-worker',
    title: 'timing: 5 sends with a stopped service worker',
    phase: 'P6.2',
    run: (h) =>
      withTabs(async (track) => {
        const tab = track(await h.openTab());
        const t = empty();
        for (let i = 0; i < 5; i += 1) {
          await h.stopWorker();
          await timedSend(h, tab, `cold ${i.toString()}`, true, t);
        }
        return report(t);
      }),
  },
];
