/**
 * Checks for the P6.5 live findings: the site's background writes are
 * blocked silently, sentinel proofs are not taken for secrets, an unknown
 * write the user did not type into stays silent, a greeting derived from an
 * email stand-in shows the real name, and values survive a browser restart.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launch, sleep, type Tab } from '../support/browser.ts';
import type { ReplyHandler } from '../support/site.ts';
import { generated, real } from '../support/values.ts';
import { assert, withTabs, type Check } from './common.ts';

const regions = async (tab: Tab): Promise<string[]> =>
  (await tab.notices())
    .filter((notice) => notice.title !== '(status)')
    .map((notice) => notice.title);

/** Made-up base64 of fixed bytes (no real token). */
const base64Run = (n: number): string =>
  Buffer.from(Array.from({ length: n }, (_, i) => (i * 37) % 256)).toString(
    'base64',
  );

export const liveFixChecks: readonly Check[] = [
  {
    id: 'background-silent',
    title:
      "the site's background writes (Statsig, telemetry) carrying a typed email are blocked without a notice",
    phase: 'P6.5',
    run: (h) =>
      withTabs(async (track) => {
        const email = real(generated.email('background'));
        const tab = track(await h.openTab());
        const mark = h.logs.mark();
        // The user types the address (e.g. into a card or a field) …
        await tab.front();
        await tab.page.click('#rename-input');
        await tab.page.keyboard.type(`Notes for ${email}`);
        await sleep(500);
        // … and the site's analytics pick it up.
        const statsig = await tab.request({
          transport: 'fetch',
          method: 'POST',
          url: '/ces/v1/rgstr?k=client-key&gz=1',
          body: JSON.stringify({
            events: [{ eventName: 'edit', metadata: { text: `to ${email}` } }],
          }),
        });
        const intake = await tab.request({
          transport: 'beacon',
          method: 'POST',
          url: '/v1/telemetry/intake',
          body: `edited text: to ${email}`,
        });
        assert(statsig === 'blocked', `the Statsig batch was ${statsig}`);
        assert(intake === 'blocked', `the telemetry intake was ${intake}`);
        await sleep(1_000);
        const shown = await regions(tab);
        assert(shown.length === 0, `notices shown: ${shown.join(', ')}`);
        const silent = h.logs.matching(
          / write-notice\.silent category=background/,
          mark,
          'page',
        ).length;
        assert(silent >= 2, `${silent.toString()} silent blocks logged`);
        return undefined;
      }),
  },
  {
    id: 'sentinel-proof',
    title:
      'a sentinel finalize request (proof ending in "~S", turnstile token) is not taken for a secret',
    phase: 'P6.5',
    run: (h) =>
      withTabs(async (track) => {
        const tab = track(await h.openTab());
        const mark = h.logs.mark();
        const outcome = await tab.request({
          transport: 'fetch',
          method: 'POST',
          url: '/backend-api/sentinel/chat-requirements/finalize',
          body: JSON.stringify({
            prepare_token: `gAAAAAC${base64Run(300)}`,
            proofofwork: `gAAAAAB${base64Run(400)}~S`,
            turnstile: `${base64Run(400)}~${base64Run(400)}`,
          }),
        });
        assert(outcome === 'sent', `the sentinel request was ${outcome}`);
        const blocked = h.logs.matching(/ net\.blocked /, mark, 'page').length;
        assert(blocked === 0, 'a block was logged');
        return undefined;
      }),
  },
  {
    id: 'unknown-write-untyped',
    title:
      'an unknown write with an email the user did not type is blocked without a notice',
    phase: 'P6.5',
    run: (h) =>
      withTabs(async (track) => {
        const email = real(generated.email('untyped'));
        const tab = track(await h.openTab());
        await tab.send('Hello there, a chat for this check.', {
          newChat: true,
        });
        await tab.page.click('#thread');
        const outcome = await tab.request({
          transport: 'fetch',
          method: 'PATCH',
          url: `/backend-api/conversation/${tab.conversationId() ?? ''}`,
          body: JSON.stringify({ title: `Notes for ${email}` }),
        });
        assert(outcome === 'blocked', `the PATCH was ${outcome}`);
        await sleep(1_000);
        const shown = await regions(tab);
        assert(shown.length === 0, `notices shown: ${shown.join(', ')}`);
        return undefined;
      }),
  },
  {
    id: 'derived-name',
    title:
      'a greeting derived from an email stand-in ("Hi Hale,") shows the real name',
    phase: 'P6.5',
    run: (h) => {
      const handler: ReplyHandler = (prompt) => {
        const m = /^Write a note to (\S+?)@/.exec(prompt);
        if (!m?.[1]) return null;
        const pieces = m[1].split(/[._+-]+/).map((p) => p.replace(/\d+/g, ''));
        const last = pieces.at(-1) ?? '';
        const name = last.charAt(0).toUpperCase() + last.slice(1);
        return { text: `Hi ${name}, here is your note.` };
      };
      h.site.replyWith(handler);
      return withTabs(async (track) => {
        const email = real(generated.email('derived name'));
        const family = (email.split('@')[0] ?? '')
          .split('.')
          .at(-1)
          ?.replace(/\d+/g, '');
        assert(family, 'no family name in the test address');
        const tab = track(await h.openTab());
        await tab.send(`Write a note to ${email}.`, { newChat: true });
        const expected = `Hi ${family.charAt(0).toUpperCase()}${family.slice(1)}, here is your note.`;
        await tab.waitForText([email, expected]);
        return undefined;
      }).finally(() => {
        h.site.replyWith(null);
      });
    },
  },
  {
    id: 'browser-restart',
    title:
      'after quitting and restarting the browser, an older chat loads and shows the real value',
    phase: 'P6.5',
    run: async (h) => {
      const email = real(generated.email('restart'));
      const profile = mkdtempSync(join(tmpdir(), 'promptveil-e2e-'));
      try {
        const first = await launch(h.site, h.extensionDir, {
          userDataDir: profile,
          logs: h.logs,
        });
        let id: string | null = null;
        try {
          const tab = await first.openTab();
          await tab.send(`Please email ${email} about the plan.`, {
            newChat: true,
          });
          await tab.waitForText([email]);
          id = tab.conversationId();
        } finally {
          await first.close();
        }
        assert(id, 'no conversation id');
        const second = await launch(h.site, h.extensionDir, {
          userDataDir: profile,
          logs: h.logs,
        });
        try {
          const mark = h.logs.mark();
          const tab = await second.openTab(`/c/${id}`);
          await h.logs.waitFor(
            / session\.loaded count=[1-9]/,
            mark,
            15_000,
            'page',
          );
          await tab.waitForText([email]);
        } finally {
          await second.close();
        }
      } finally {
        rmSync(profile, { recursive: true, force: true });
      }
      return undefined;
    },
  },
];
