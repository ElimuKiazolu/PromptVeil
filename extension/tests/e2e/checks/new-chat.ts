/**
 * In-app "New chat" (P6.6 live finding): ChatGPT mounts a fresh composer
 * while the previous one is still in the page, and the first send shows
 * /c/local-chatgpt%3A<uuid> before the server's /c/<id>. The send must be
 * masked, the pending chat migrated to the real ID, reused and restored.
 */
import { waitFor } from '../support/browser.ts';
import type { PageApi } from '../support/page.ts';
import { generated, real } from '../support/values.ts';
import { assert, assertNoReal, withTabs, type Check } from './common.ts';

/** The email stand-in in "Write a note to X." */
function noteRecipient(text: string): string {
  const match = /^Write a note to (\S+@\S+?)\.$/.exec(text);
  assert(match?.[1], 'no address in the received message');
  return match[1];
}

export const newChatChecks: readonly Check[] = [
  {
    id: 'in-app-new-chat',
    title:
      'after an in-app New chat (new composer, /c/local-… URL) the send is masked, migrated, reused and restored',
    phase: 'P6.6',
    run: (h) =>
      withTabs(async (track) => {
        const email = real(generated.email('in-app new chat'));
        const prompt = `Write a note to ${email}.`;
        const tab = track(await h.openTab());
        await tab.send('Hello there, the chat before.', { newChat: true });
        // ChatGPT's own New chat: no page load, a new composer mounted.
        await tab.front();
        await tab.page.click('#new-chat-app');
        await waitFor(() => tab.url().pathname === '/', 5_000, 'new chat');
        const composers = await tab.page.$$eval(
          'form[data-chatgpt-composer]',
          (forms) => forms.length,
        );
        assert(composers === 2, `${composers.toString()} composers mounted`);

        const mark = h.logs.mark();
        const first = await tab.send(prompt);
        assertNoReal(first.received, [email], 'the first message');
        await h.logs.waitFor(/ send\.masked /, mark, 5_000, 'page');
        const locals = await tab.page.evaluate(
          () => (Reflect.get(window, '__pv') as PageApi).localUrls.length,
        );
        assert(locals === 1, 'the page showed no /c/local-… URL');
        await waitFor(() => tab.conversationId(), 10_000, 'the real ID');
        await h.logs.waitFor(/ session\.migrated/, mark, 10_000, 'page');
        await h.logs.waitFor(/ vault\.migrated/, mark, 10_000, 'worker');

        const second = await tab.send(prompt);
        assert(
          noteRecipient(second.received) === noteRecipient(first.received),
          'the second send got another stand-in',
        );
        await tab.waitForText([prompt]);
        await tab.reload();
        await tab.waitForText([prompt]);
        return undefined;
      }),
  },
];
