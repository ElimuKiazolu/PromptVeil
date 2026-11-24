/**
 * Notices for stopped writes and the card early warning (P6.4), read through
 * the accessibility tree. No notice may carry a value.
 */
import { sleep, waitFor, type Notice, type Tab } from '../support/browser.ts';
import { field } from '../support/browser.ts';
import { generated, real } from '../support/values.ts';
import { assert, carries, stats, withTabs, type Check } from './common.ts';
import { chatWithCard } from './writes.ts';

/** Waits for a notice with this title; throws if none shows in time. */
function noticeTitled(
  tab: Tab,
  title: string,
  timeout = 10_000,
): Promise<Notice> {
  return waitFor(
    async () => (await tab.notices()).find((n) => n.title === title) ?? null,
    timeout,
    `notice "${title}"`,
  );
}

function assertNoValue(
  notices: readonly Notice[],
  values: readonly string[],
): void {
  for (const notice of notices) {
    assert(
      !values.some((value) => carries(notice.text, value)),
      'a notice carries a real value',
    );
  }
}

const regions = (notices: readonly Notice[]): Notice[] =>
  notices.filter((n) => n.title !== '(status)');

export const noticeChecks: readonly Check[] = [
  {
    id: 'notice-card-blocked',
    title:
      'a blocked card save shows "This edit wasn\'t saved" under the card, with counts only',
    phase: 'P6.4',
    run: (h) =>
      withTabs(async (track) => {
        const email = real(generated.email('notice card'));
        const tab = track(await h.openTab());
        await chatWithCard(h, tab, 'notice card chat');
        const outcome = await tab.typeInCard(` Reach me at ${email}.`);
        assert(outcome === 'failed', `the save was ${outcome}`);
        const notice = await noticeTitled(tab, "This edit wasn't saved");
        assert(
          notice.text.includes(
            'It has 1 email. PromptVeil stopped ChatGPT from storing it.',
          ),
          'the notice does not name 1 email',
        );
        assertNoValue(await tab.notices(), [email]);
        return undefined;
      }),
  },
  {
    id: 'notice-card-clean',
    title: 'a clean card edit shows no notice',
    phase: 'P6.4',
    run: (h) =>
      withTabs(async (track) => {
        const tab = track(await h.openTab());
        await chatWithCard(h, tab, 'notice clean chat');
        const outcome = await tab.typeInCard(' See you at 6 or 7 pm.');
        assert(outcome === 'saved', `the save was ${outcome}`);
        await sleep(1_000);
        const shown = regions(await tab.notices());
        assert(
          shown.length === 0,
          `notices shown: ${shown.map((n) => n.title).join(', ')}`,
        );
        return undefined;
      }),
  },
  {
    id: 'notice-rename',
    title:
      'a blocked chat rename shows the page-level notice; a clean rename hides it',
    phase: 'P6.4',
    run: (h) =>
      withTabs(async (track) => {
        const email = real(generated.email('notice rename'));
        const tab = track(await h.openTab());
        await tab.send('Hello there, a chat to rename.', { newChat: true });
        const blocked = await tab.rename(`Notes for ${email}`);
        assert(blocked === 'failed', `the rename was ${blocked}`);
        const notice = await noticeTitled(tab, 'Not saved');
        assert(
          notice.text.includes(
            'Something you typed has 1 email. PromptVeil stopped ChatGPT from storing it. Remove it and try again.',
          ),
          'unexpected notice text',
        );
        assertNoValue(await tab.notices(), [email]);
        const clean = await tab.rename('Weekly plan');
        assert(clean === 'saved', `the clean rename was ${clean}`);
        await waitFor(
          async () => regions(await tab.notices()).length === 0,
          5_000,
          'notice to go',
        );
        return undefined;
      }),
  },
  {
    id: 'notice-early-warning',
    title: 'typing a value into a card warns before the card is saved',
    phase: 'P6.4',
    run: (h) =>
      withTabs(async (track) => {
        const phone = real(generated.ukMobile('early warning'));
        const tab = track(await h.openTab());
        await chatWithCard(h, tab, 'early warning chat');
        const before = await tab.cardSaves();
        const mark = h.logs.mark();
        const started = Date.now();
        await tab.startTypingInCard(` Call me on ${phone}.`);
        const typed = Date.now();
        const warning = await noticeTitled(
          tab,
          'Personal data in this card',
          5_000,
        );
        const warnedAfter = Date.now() - typed;
        assert(
          (await tab.cardSaves()) === before,
          'the card was saved before the warning',
        );
        assert(
          warning.text.includes('It has 1 phone number.'),
          'the warning does not name 1 phone number',
        );
        assertNoValue(await tab.notices(), [phone]);
        // The save that follows is stopped, and the notice says so.
        await waitFor(
          async () => (await tab.cardSaves()) > before,
          10_000,
          'card save',
        );
        await noticeTitled(tab, "This edit wasn't saved");
        const scans = h.logs
          .matching(/ write-notice\.scanned /, mark, 'page')
          .map((line) => field(line.text, 'ms') ?? 0);
        return `warning ${warnedAfter.toString()} ms after typing ended (typing took ${(typed - started).toString()} ms); card check median/p95 ${stats(scans)} ms`;
      }),
  },
];
