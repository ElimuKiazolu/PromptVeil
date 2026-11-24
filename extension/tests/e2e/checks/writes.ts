/**
 * Every first-party write (P6.3): writing-card saves, other writes, and
 * values masked earlier sent entity-escaped.
 */
import type { Harness, Tab } from '../support/browser.ts';
import { PUBLISHED, generated, real } from '../support/values.ts';
import { assert, carries, withTabs, type Check } from './common.ts';

/** Opens a chat whose reply has a writing card (the prompt's email masked). */
export async function chatWithCard(
  h: Harness,
  tab: Tab,
  label: string,
): Promise<void> {
  const email = real(generated.email(label));
  const sent = await tab.send(`Draft an email to ${email} about the plan.`, {
    newChat: true,
  });
  assert(!carries(sent.received, email), 'the prompt email reached the site');
  await tab.page.waitForSelector('[data-card]', { timeout: 10_000 });
}

/** Card saves the site received since `before`. */
function savedSince(h: Harness, before: number): string[] {
  return h.site.requests
    .slice(before)
    .filter((r) => r.url.includes('/writing-blocks'))
    .map((r) => r.body);
}

function cardBlock(id: string, title: string, typed: () => string): Check {
  return {
    id,
    title,
    phase: 'P6.3',
    run: (h) =>
      withTabs(async (track) => {
        const tab = track(await h.openTab());
        await chatWithCard(h, tab, id);
        const before = h.site.requests.length;
        const value = typed();
        const outcome = await tab.typeInCard(` Reach me at ${value}.`);
        assert(outcome === 'failed', `the save was ${outcome}`);
        assert(
          !savedSince(h, before).some((body) => carries(body, value)),
          'the value reached the site',
        );
        return undefined;
      }),
  };
}

export const writeChecks: readonly Check[] = [
  {
    id: 'send-clean-and-masked',
    title:
      'a normal send is masked and restored; a clean prompt goes through unchanged',
    phase: 'P6.3',
    run: (h) =>
      withTabs(async (track) => {
        const email = real(PUBLISHED.email);
        const tab = track(await h.openTab());
        const sent = await tab.send(`Please email ${email} the minutes.`, {
          newChat: true,
        });
        assert(!carries(sent.received, email), 'the real email was sent');
        assert(
          /@example\.(?:com|org|net)/.test(sent.received),
          'no stand-in in the message',
        );
        await tab.waitForText([email]);
        const clean = 'What is a good agenda for a team meeting?';
        const plain = await tab.send(clean, { newChat: true });
        assert(plain.received === clean, 'a clean prompt was changed');
        return undefined;
      }),
  },
  cardBlock(
    'card-email',
    'writing card: a save with a new email is blocked',
    () => real(generated.email('card new email')),
  ),
  cardBlock(
    'card-phone',
    'writing card: a save with a new phone number is blocked',
    () => real(generated.ukMobile('card new phone')),
  ),
  cardBlock(
    'card-nino',
    'writing card: a save with a new national ID is blocked',
    () => real(generated.nino('card new nino')),
  ),
  {
    id: 'card-clean',
    title: 'writing card: a clean edit is saved',
    phase: 'P6.3',
    run: (h) =>
      withTabs(async (track) => {
        const tab = track(await h.openTab());
        await chatWithCard(h, tab, 'card clean');
        const outcome = await tab.typeInCard(' See you at 6 or 7 pm.');
        assert(outcome === 'saved', `the save was ${outcome}`);
        return undefined;
      }),
  },
  {
    id: 'escaped-masked-xhr',
    title:
      'values masked earlier, entity-escaped in an XHR write, are blocked (tier 2)',
    phase: 'P6.3',
    run: (h) =>
      withTabs(async (track) => {
        const phone = real(generated.ukMobile('escaped'));
        const nino = real(generated.nino('escaped'));
        const tab = track(await h.openTab());
        const mark = h.logs.mark();
        const sent = await tab.send(`Call ${phone} and note NI ${nino}.`, {
          newChat: true,
        });
        assert(
          !carries(sent.received, phone) && !carries(sent.received, nino),
          'a real value was sent',
        );
        await h.logs.waitFor(/ net\.synced/, mark, 10_000, 'page');
        const id = tab.conversationId() ?? '';
        for (const content of [
          `Ring ${phone.replace(' ', '&#x20;')}`,
          `NI ${nino.replaceAll(' ', '&nbsp;')}`,
        ]) {
          const outcome = await tab.request({
            transport: 'xhr',
            method: 'POST',
            url: `/backend-api/conversation/${id}/writing-blocks`,
            body: JSON.stringify({
              writing_block: { content, metadata: { recipient: null } },
            }),
          });
          assert(outcome === 'blocked', `the XHR save was ${outcome}`);
        }
        return undefined;
      }),
  },
  {
    id: 'unknown-patch',
    title: 'an unknown PATCH: an email is blocked; IDs and tokens pass',
    phase: 'P6.3',
    run: (h) =>
      withTabs(async (track) => {
        const email = real(generated.email('patch'));
        const tab = track(await h.openTab());
        await tab.send('Hello there, a new chat.', { newChat: true });
        const url = `/backend-api/conversation/${tab.conversationId() ?? ''}`;
        const withEmail = await tab.request({
          transport: 'fetch',
          method: 'PATCH',
          url,
          body: JSON.stringify({ title: `Notes for ${email}` }),
        });
        assert(
          withEmail === 'blocked',
          `the PATCH with an email was ${withEmail}`,
        );
        const machine = await tab.request({
          transport: 'fetch',
          method: 'PATCH',
          url,
          body: JSON.stringify({
            conversation_id: '6acdb6c3-576c-83ee-9afa-959dd6bab8ce',
            proof_token: 'gAAAAABoQ3x9Zk1lM2V4YW1wbGVfdG9rZW5fdmFsdWU=',
            updated_at: new Date().toISOString(),
            is_archived: true,
          }),
        });
        assert(machine === 'sent', `the machine PATCH was ${machine}`);
        return undefined;
      }),
  },
];
