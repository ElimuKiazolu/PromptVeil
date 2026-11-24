/**
 * Conversations, the vault session and the extension's life cycle
 * (P4.2 checks, automated in P5.1; P6.1 added the immediate refresh).
 */
import { sleep, type Harness } from '../support/browser.ts';
import { generated, real } from '../support/values.ts';
import { assert, assertNoReal, withTabs, type Check } from './common.ts';

/** The email stand-in in "… email X about …". */
export function emailIn(text: string): string {
  const match = /email (\S+@\S+?) about/.exec(text);
  assert(match?.[1], 'no email in the received message');
  return match[1];
}

/** Deletes everything through the dev helper in the service worker. */
export async function deleteAll(h: Harness): Promise<string> {
  const worker = await h.worker();
  return worker.evaluate(async () => {
    const dev = Reflect.get(globalThis, 'promptveilDev') as {
      deleteAll(): Promise<string>;
    };
    return dev.deleteAll();
  });
}

export const sessionChecks: readonly Check[] = [
  {
    id: 'new-chat-migration',
    title:
      'new chat: values move to the conversation ID; the same value keeps its stand-in',
    phase: 'P4.2',
    run: (h) =>
      withTabs(async (track) => {
        const email = real(generated.email('migration'));
        const tab = track(await h.openTab());
        const mark = h.logs.mark();
        const first = await tab.send(`Please email ${email} about the plan.`, {
          newChat: true,
        });
        assertNoReal(first.received, [email], 'the first message');
        await h.logs.waitFor(/ session\.migrated/, mark, 10_000, 'page');
        await h.logs.waitFor(/ vault\.migrated/, mark, 10_000, 'worker');
        const again = await tab.send(`Also email ${email} about the budget.`);
        assert(
          emailIn(again.received) === emailIn(first.received),
          'the same value got another stand-in after the move',
        );
        await tab.waitForText([email]);
        return undefined;
      }),
  },
  {
    id: 'stand-in-reuse',
    title: 'one value, one stand-in: repeated in a prompt and across sends',
    phase: 'P4.2',
    run: (h) =>
      withTabs(async (track) => {
        const phone = real(generated.ukMobile('reuse'));
        const tab = track(await h.openTab());
        const first = await tab.send(
          `Call ${phone} today or ${phone} tomorrow.`,
          {
            newChat: true,
          },
        );
        assertNoReal(first.received, [phone], 'the message');
        const inPrompt = /Call (.+) today or (.+) tomorrow\./.exec(
          first.received,
        );
        assert(
          inPrompt?.[1] && inPrompt[1] === inPrompt[2],
          'two stand-ins in one prompt',
        );
        const second = await tab.send(`Ring ${phone} again.`);
        assert(
          second.received === `Ring ${inPrompt[1]} again.`,
          'another stand-in in the next send',
        );
        await tab.waitForText([`Ring ${phone} again.`]);
        return undefined;
      }),
  },
  {
    id: 'refresh',
    title: 'refresh: values load from the vault and the reply shows them again',
    phase: 'P4.2',
    run: (h) =>
      withTabs(async (track) => {
        const email = real(generated.email('refresh'));
        const phone = real(generated.ukMobile('refresh'));
        const tab = track(await h.openTab());
        await tab.send(`Please email ${email} about it, or call ${phone}.`, {
          newChat: true,
        });
        await tab.waitForText([email, phone]);
        const mark = h.logs.mark();
        await tab.reload();
        const loaded = await h.logs.waitFor(
          / session\.loaded count=2\b/,
          mark,
          15_000,
          'page',
        );
        assert(loaded, 'values not loaded');
        await h.logs.waitFor(/ net\.synced/, mark, 10_000, 'page');
        await tab.waitForText([email, phone]);
        return undefined;
      }),
  },
  {
    id: 'two-tabs',
    title:
      'two tabs on one conversation: the other tab loads the new value and restores it',
    phase: 'P4.2',
    run: (h) =>
      withTabs(async (track) => {
        const first = real(generated.email('two tabs 1'));
        const second = real(generated.email('two tabs 2'));
        const a = track(await h.openTab());
        await a.send(`Please email ${first} about the plan.`, {
          newChat: true,
        });
        const id = a.conversationId();
        assert(id, 'no conversation id');
        const b = track(await h.openTab(`/c/${id}`));
        await b.waitForText([first]);
        const mark = h.logs.mark();
        await a.send(`Please email ${second} about the minutes.`);
        await h.logs.waitFor(
          / session\.loaded count=2\b/,
          mark,
          10_000,
          'page',
        );
        await b.front();
        await b.waitForText([second]);
        return undefined;
      }),
  },
  {
    id: 'navigation',
    title:
      'chat switching (client-side navigation) loads the other chat at once',
    phase: 'P4.2',
    run: (h) =>
      withTabs(async (track) => {
        const one = real(generated.email('navigation 1'));
        const two = real(generated.email('navigation 2'));
        const tab = track(await h.openTab());
        await tab.send(`Please email ${one} about the plan.`, {
          newChat: true,
        });
        const firstId = tab.conversationId();
        assert(firstId, 'no conversation id');
        await tab.send(`Please email ${two} about the plan.`, {
          newChat: true,
        });
        const mark = h.logs.mark();
        const started = Date.now();
        await tab.openConversation(firstId);
        const switched = await h.logs.waitFor(
          / session\.conversation/,
          mark,
          5_000,
          'page',
        );
        await h.logs.waitFor(
          / session\.loaded count=1\b/,
          mark,
          10_000,
          'page',
        );
        await tab.waitForText([one]);
        return `switch logged after ${(switched.at - started).toString()} ms`;
      }),
  },
  {
    id: 'worker-restart',
    title: 'a stopped service worker wakes on the next send',
    phase: 'P4.2',
    run: (h) =>
      withTabs(async (track) => {
        const email = real(generated.email('worker'));
        const later = real(generated.email('worker later'));
        const tab = track(await h.openTab());
        await tab.send(`Please email ${email} about the plan.`, {
          newChat: true,
        });
        await h.stopWorker();
        const result = await tab.send(
          `Please email ${later} about the budget.`,
        );
        assertNoReal(result.received, [later], 'the message');
        await tab.waitForText([later]);
        return `send after stop reached the site in ${result.ms.toString()} ms`;
      }),
  },
  {
    id: 'orphaned-tab',
    title:
      'after an extension reload, a tab opened before blocks sends with the prompt unchanged',
    phase: 'P4.2',
    run: (h) =>
      withTabs(async (track) => {
        const email = real(generated.email('orphan'));
        const old = track(await h.openTab());
        await h.reloadExtension();
        const mark = h.logs.mark();
        const prompt = `Please email ${email} about the plan.`;
        // The first Enter finds the context gone (unless the 2 s heartbeat
        // did first) and installs the guard; the next one meets the guard.
        await old.sendBlocked(prompt);
        await h.logs.waitFor(/ instance\.orphaned/, mark, 5_000, 'page');
        await old.pressEnterBlocked();
        assert((await old.editorText()) === prompt, 'the prompt changed');
        await h.logs.waitFor(/ guard\.blocked/, mark, 5_000, 'page');
        const fresh = track(await h.openTab());
        const result = await fresh.send(prompt, { newChat: true });
        assertNoReal(result.received, [email], 'the message from a new tab');
        return undefined;
      }),
  },
  {
    id: 'messaging-errors',
    title:
      'messaging failures: no receiver rejects; a notice to an orphaned tab is counted',
    phase: 'P4.2',
    run: (h) =>
      withTabs(async (track) => {
        const other = track(await h.openOtherSite());
        await other.bringToFront();
        const worker = await h.worker();
        const errors = await worker.evaluate(async () => {
          // The worker's own chrome.* API (the harness has no types for it).
          interface ChromeApi {
            tabs: {
              query(q: object): Promise<{ id?: number }[]>;
              sendMessage(tabId: number, message: object): Promise<unknown>;
            };
            runtime: {
              sendMessage(
                extensionId: string,
                message: object,
              ): Promise<unknown>;
            };
          }
          const chrome = Reflect.get(globalThis, 'chrome') as ChromeApi;
          const message = (error: unknown): string =>
            error instanceof Error ? error.message : String(error);
          const [tab] = await chrome.tabs.query({
            active: true,
            lastFocusedWindow: true,
          });
          const toTab =
            tab?.id === undefined
              ? 'no tab'
              : await chrome.tabs
                  .sendMessage(tab.id, {})
                  .then(() => 'resolved', message);
          const toExtension = await chrome.runtime
            .sendMessage('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', {})
            .then(() => 'resolved', message);
          return [toTab, toExtension];
        });
        const expected =
          'Could not establish connection. Receiving end does not exist.';
        assert(
          errors.every((error) => error === expected),
          `unexpected messaging results: ${errors.join(' | ')}`,
        );
        // A notice to a tab whose content script is orphaned fails.
        const email = real(generated.email('notice'));
        const later = real(generated.email('notice later'));
        const sender = track(await h.openTab());
        await sender.send(`Please email ${email} about the plan.`, {
          newChat: true,
        });
        const id = sender.conversationId();
        assert(id, 'no conversation id');
        const orphan = track(await h.openTab(`/c/${id}`));
        await orphan.waitForText([email]);
        await sender.close();
        await h.reloadExtension();
        const fresh = track(await h.openTab(`/c/${id}`));
        await fresh.waitForText([email]);
        const mark = h.logs.mark();
        await fresh.send(`Please email ${later} about the minutes.`);
        await h.logs.waitFor(
          / notice\.failed count=1\b/,
          mark,
          10_000,
          'worker',
        );
        return undefined;
      }),
  },
  {
    id: 'delete-all',
    title:
      'delete-all: open tabs drop their values; after refresh the chat shows stand-ins',
    phase: 'P4.2',
    run: (h) =>
      withTabs(async (track) => {
        const email = real(generated.email('delete all'));
        const tab = track(await h.openTab());
        const sent = await tab.send(`Please email ${email} about the plan.`, {
          newChat: true,
        });
        await tab.waitForText([email]);
        const mark = h.logs.mark();
        assert((await deleteAll(h)) === 'ready', 'delete-all did not finish');
        await h.logs.waitFor(/ session\.dropped/, mark, 10_000, 'page');
        await tab.reload();
        await tab.waitForText([sent.received]);
        await sleep(2_000);
        assert(
          !(await tab.text()).includes(email),
          'the real value is still restored',
        );
        return undefined;
      }),
  },
  {
    id: 'back-forward-cache',
    title:
      'leaving for another site and coming back shows the real values again',
    phase: 'P4.2',
    run: (h) =>
      withTabs(async (track) => {
        const email = real(generated.email('bfcache'));
        const tab = track(await h.openTab());
        await tab.send(`Please email ${email} about the plan.`, {
          newChat: true,
        });
        await tab.waitForText([email]);
        const mark = h.logs.mark();
        await tab.page.goto('https://other.test/', { waitUntil: 'load' });
        await tab.page.goBack({ waitUntil: 'load' });
        await tab.front();
        const fromCache = (await tab.pageshows()).at(-1) === true;
        await h.logs.waitFor(
          / session\.loaded count=1\b/,
          mark,
          15_000,
          'page',
        );
        await tab.waitForText([email]);
        return fromCache
          ? 'restored from the back/forward cache'
          : 'page loaded again (not cached)';
      }),
  },
  {
    id: 'refresh-after-id',
    title:
      'refresh right after the new chat gets its ID loads every value (5 runs)',
    phase: 'P6.1',
    run: (h) =>
      withTabs(async (track) => {
        const tab = track(await h.openTab());
        for (let run = 0; run < 5; run += 1) {
          const email = real(
            generated.email(`quick refresh ${run.toString()}`),
          );
          const phone = real(
            generated.ukMobile(`quick refresh ${run.toString()}`),
          );
          await tab.send(`Please email ${email} about it, or call ${phone}.`, {
            newChat: true,
          });
          const mark = h.logs.mark();
          await tab.reload();
          const loaded = await h.logs.waitFor(
            / session\.loaded count=\d+/,
            mark,
            15_000,
            'page',
          );
          assert(
            / session\.loaded count=2\b/.test(loaded.text),
            `run ${run.toString()}: loaded ${loaded.text.split(' ').at(-1) ?? ''}`,
          );
          await tab.waitForText([email, phone]);
        }
        return undefined;
      }),
  },
];
