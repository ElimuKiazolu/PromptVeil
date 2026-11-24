/**
 * Masking, restoring and the request net for every rule type
 * (P5.1 email path, P6.1 multi-type and request net, P6.2 rewritten
 * stand-ins, P5.3 IP and crypto, P5.4 dates of birth, forced vault error).
 */
import type { Harness } from '../support/browser.ts';
import type { PageRequest } from '../support/page.ts';
import type { ReplyHandler } from '../support/site.ts';
import {
  AWS_STYLE_KEY,
  PUBLISHED,
  generated,
  real,
} from '../support/values.ts';
import {
  assert,
  assertNoReal,
  carries,
  withTabs,
  type Check,
} from './common.ts';
import { deleteAll, emailIn } from './session.ts';

/** Runs `body` with a reply builder installed on the site. */
async function withReplies<T>(
  h: Harness,
  handler: ReplyHandler,
  body: () => Promise<T>,
): Promise<T> {
  h.site.replyWith(handler);
  try {
    return await body();
  } finally {
    h.site.replyWith(null);
  }
}

/** The seven values of the P6.1 multi-type prompt. */
function multiType(): Record<string, string> {
  return {
    phone: real(PUBLISHED.phone),
    nino: real(PUBLISHED.nino),
    cpf: real(PUBLISHED.cpf),
    card: real(PUBLISHED.card),
    iban: real(PUBLISHED.iban),
    key: real(AWS_STYLE_KEY),
    email: real(PUBLISHED.email),
  };
}

function multiTypePrompt(v: Record<string, string>): string {
  return `My phone is ${v.phone ?? ''}, NI number ${v.nino ?? ''}, CPF ${v.cpf ?? ''}, card ${v.card ?? ''}, IBAN ${v.iban ?? ''}, AWS key ${v.key ?? ''}, email ${v.email ?? ''}.`;
}

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

function ageOn(day: number, month: number, year: number, today: Date): number {
  const before =
    today.getMonth() + 1 < month ||
    (today.getMonth() + 1 === month && today.getDate() < day);
  return today.getFullYear() - year - (before ? 1 : 0);
}

/** Waits for the replies' leak checks and requires each to count 0. */
async function assertNoLeak(h: Harness, mark: number): Promise<void> {
  await h.logs.waitFor(/ restore\.leak-check count=/, mark, 15_000, 'page');
  const leaks = h.logs
    .matching(/ restore\.leak-check count=[1-9]/, mark, 'page')
    .map((line) => line.text);
  assert(leaks.length === 0, `stand-ins left visible: ${leaks.join(' | ')}`);
}

export const maskingChecks: readonly Check[] = [
  {
    id: 'email-prepare-commit',
    title:
      'email: one vault commit per send, a reserved-domain stand-in, another in another chat, reused on return',
    phase: 'P5.1',
    run: (h) =>
      withTabs(async (track) => {
        const email = real(generated.email('commit'));
        const tab = track(await h.openTab());
        const mark = h.logs.mark();
        const first = emailIn(
          (
            await tab.send(`Please email ${email} about the plan.`, {
              newChat: true,
            })
          ).received,
        );
        const firstId = tab.conversationId();
        assert(firstId, 'no conversation id');
        assert(
          /^[a-z]+(?:[._][a-z]+)*\d*@example\.(?:com|org|net)$/i.test(first) &&
            !first.startsWith('standin.'),
          'the stand-in is not a name-based reserved-domain address',
        );
        const other = emailIn(
          (
            await tab.send(`Please email ${email} about the plan.`, {
              newChat: true,
            })
          ).received,
        );
        assert(other !== first, 'another conversation reused the stand-in');
        await tab.openConversation(firstId);
        await h.logs.waitFor(
          / session\.loaded count=1\b/,
          mark,
          10_000,
          'page',
        );
        const back = emailIn(
          (await tab.send(`Please email ${email} about the budget.`)).received,
        );
        assert(back === first, 'the stand-in changed on return');
        await tab.waitForText([`Please email ${email} about the budget.`]);
        const commits = h.logs.matching(
          / vault\.masked /,
          mark,
          'worker',
        ).length;
        assert(
          commits === 3,
          `${commits.toString()} vault commits for 3 sends`,
        );
        return undefined;
      }),
  },
  {
    id: 'multi-type',
    title:
      'multi-type prompt: only stand-ins reach the site; the reply and a refresh show the real values',
    phase: 'P6.1',
    run: (h) =>
      withTabs(async (track) => {
        const values = multiType();
        const tab = track(await h.openTab());
        const sent = await tab.send(multiTypePrompt(values), { newChat: true });
        assertNoReal(sent.received, Object.values(values), 'the message');
        await tab.waitForText(Object.values(values));
        await tab.reload();
        await tab.waitForText(Object.values(values));
        return undefined;
      }),
  },
  {
    id: 'net-other-writings',
    title:
      'request net blocks every masked value in other writings (query, \\u-escaped JSON, hyphens, case, beacon)',
    phase: 'P6.1',
    run: (h) =>
      withTabs(async (track) => {
        const v = multiType();
        const tab = track(await h.openTab());
        const mark = h.logs.mark();
        await tab.send(multiTypePrompt(v), { newChat: true });
        await h.logs.waitFor(/ net\.synced/, mark, 10_000, 'page');
        const writings: readonly string[] = [
          (v.phone ?? '')
            .replaceAll(' ', '-')
            .replace(/^(\d{5})-(\d{3})/, '$1-$2-'),
          (v.nino ?? '').replaceAll(' ', '').toLowerCase(),
          (v.cpf ?? '').replace(/\D/g, ''),
          (v.card ?? '').replaceAll(' ', '-'),
          (v.iban ?? '').replaceAll(' ', '').toLowerCase(),
          v.key ?? '',
          (v.email ?? '').toUpperCase(),
        ];
        /** Every UTF-16 unit as a JSON \u escape. */
        const escaped = (text: string): string => {
          let out = '';
          for (let i = 0; i < text.length; i += 1) {
            out += `\\u${text.charCodeAt(i).toString(16).padStart(4, '0')}`;
          }
          return out;
        };
        const before = h.site.requests.length;
        const blockedMark = h.logs.mark();
        let probes = 0;
        for (const writing of writings) {
          const requests: PageRequest[] = [
            {
              transport: 'fetch',
              method: 'GET',
              url: `/backend-api/search?q=${encodeURIComponent(`find ${writing}`)}`,
              body: null,
            },
            {
              transport: 'xhr',
              method: 'POST',
              url: '/backend-api/notes',
              body: `{"note":"${escaped(writing)}"}`,
            },
            {
              transport: 'beacon',
              method: 'POST',
              url: '/ces/v1/t',
              body: JSON.stringify({ event: 'typed', text: `see ${writing}` }),
            },
          ];
          for (const request of requests) {
            probes += 1;
            const outcome = await tab.request(request);
            assert(
              outcome === 'blocked',
              `${request.transport} request was ${outcome}`,
            );
          }
        }
        const control = await tab.request({
          transport: 'fetch',
          method: 'GET',
          url: '/backend-api/search?q=agenda',
          body: null,
        });
        assert(control === 'sent', 'a clean request was blocked');
        const reached = h.site.requests
          .slice(before)
          .filter((r) =>
            Object.values(v).some((value) => carries(r.url + r.body, value)),
          );
        assert(reached.length === 0, 'a real value reached the site');
        const blocked = h.logs.matching(
          / net\.blocked tier=[12]/,
          blockedMark,
          'page',
        ).length;
        assert(
          blocked >= probes,
          `${blocked.toString()} blocks logged for ${probes.toString()} requests`,
        );
        return `${probes.toString()} requests blocked, clean request sent`;
      }),
  },
  {
    id: 'review-demo',
    title:
      'Review 1 demo: a CV prompt with a NINO and a CPF is masked and restored',
    phase: 'P6.1',
    run: (h) =>
      withTabs(async (track) => {
        const nino = real(PUBLISHED.nino);
        const cpf = real(PUBLISHED.cpf);
        const tab = track(await h.openTab());
        const sent = await tab.send(
          `Please tighten my CV summary. NI number ${nino}, CPF ${cpf}. I lead a team of five.`,
          { newChat: true },
        );
        assertNoReal(sent.received, [nino, cpf], 'the message');
        assert(
          /\bTN \d\d \d\d \d\d [A-D]\b/.test(sent.received),
          'NINO stand-in not in the TN range',
        );
        assert(
          /\b\d{3}\.\d{3}\.\d{3}-\d{2}\b/.test(sent.received),
          'CPF stand-in lost its format',
        );
        await tab.waitForText([nino, cpf]);
        return undefined;
      }),
  },
  {
    id: 'rewritten-stand-ins',
    title:
      'a reply that rewrites every stand-in in another format shows the real values in that format',
    phase: 'P6.2',
    run: (h) => {
      const handler: ReplyHandler = (prompt) => {
        const m =
          /^Format check: phone (.+?), NI (.+?), CPF (.+?), card (.+?), IBAN (.+?)\.$/.exec(
            prompt,
          );
        if (!m) return null;
        const [, phone = '', nino = '', cpf = '', card = '', iban = ''] = m;
        // The prompt writes the phone with +44, so its stand-in does too.
        const national = phone.replace(/^\+44 /, '');
        return {
          text: [
            `Phone 0${national} or 0044 ${national}.`,
            `NI ${nino.toLowerCase()}.`,
            `CPF ${cpf.replace(/\D/g, '')}.`,
            `Card ${card.replaceAll(' ', '-')}, the card ending in ${card.slice(-4)}.`,
            `IBAN ${iban.replaceAll(' ', '')}.`,
          ].join(' '),
        };
      };
      return withReplies(h, handler, () =>
        withTabs(async (track) => {
          // Written with +44, it reads as a UK number whatever the home
          // region (written nationally, 07400 123456 is also a valid
          // German number, and an en-US browser reads it as one).
          const phone = real(`+44 ${PUBLISHED.phone.slice(1)}`);
          const nino = real(PUBLISHED.nino);
          const cpf = real(PUBLISHED.cpf);
          const card = real(PUBLISHED.card);
          const iban = real(PUBLISHED.iban);
          const tab = track(await h.openTab());
          const mark = h.logs.mark();
          await tab.send(
            `Format check: phone ${phone}, NI ${nino}, CPF ${cpf}, card ${card}, IBAN ${iban}.`,
            { newChat: true },
          );
          await tab.waitForText([
            `0${phone.slice(4)}`,
            `0044 ${phone.slice(4)}`,
            nino.toLowerCase(),
            cpf.replace(/\D/g, ''),
            card.replaceAll(' ', '-'),
            `ending in ${card.slice(-4)}`,
            iban.replaceAll(' ', ''),
          ]);
          await assertNoLeak(h, mark);
          return undefined;
        }),
      );
    },
  },
  {
    id: 'keys-lost',
    title:
      'forced vault error (keys lost): the send is blocked with the prompt unchanged; delete-all recovers',
    phase: 'P5.1',
    run: (h) =>
      withTabs(async (track) => {
        const email = real(generated.email('keys lost'));
        const later = real(generated.email('keys lost later'));
        const tab = track(await h.openTab());
        await tab.send(`Please email ${email} about the plan.`, {
          newChat: true,
        });
        const worker = await h.worker();
        await worker.evaluate(
          () =>
            new Promise<void>((resolve, reject) => {
              const open = indexedDB.open('promptveil');
              open.onerror = () => {
                reject(new Error('open failed'));
              };
              open.onsuccess = () => {
                const db = open.result;
                const tx = db.transaction('keys', 'readwrite');
                tx.objectStore('keys').delete('enc');
                tx.oncomplete = () => {
                  db.close();
                  resolve();
                };
                tx.onerror = () => {
                  reject(new Error('delete failed'));
                };
              };
            }),
        );
        // The running worker holds the keys in memory; a restart reads them.
        await h.stopWorker();
        const mark = h.logs.mark();
        const prompt = `Please email ${later} about the budget.`;
        await tab.sendBlocked(prompt, 4_000);
        assert((await tab.editorText()) === prompt, 'the prompt changed');
        const blocked = await h.logs.waitFor(
          / send\.blocked/,
          mark,
          5_000,
          'page',
        );
        assert((await deleteAll(h)) === 'ready', 'delete-all did not finish');
        const fresh = track(await h.openTab());
        const result = await fresh.send(prompt, { newChat: true });
        assertNoReal(result.received, [later], 'the message after delete-all');
        return blocked.text.replace(/^.* send\.blocked/, 'send.blocked');
      }),
  },
  {
    id: 'ip-crypto',
    title:
      'IP and crypto addresses: documentation-range and same-format stand-ins; private IP kept; restored after refresh',
    phase: 'P5.3',
    run: (h) =>
      withTabs(async (track) => {
        const ip = real(generated.publicIpv4('ip check'));
        const segwit = real(PUBLISHED.segwit);
        const eth = real(PUBLISHED.ethereum);
        const btc = real(generated.bitcoin('btc check'));
        const tab = track(await h.openTab());
        const sent = await tab.send(
          `Server ${ip}, wallet ${segwit}, ETH ${eth}, BTC ${btc}, router 192.168.1.20.`,
          { newChat: true },
        );
        const r = sent.received;
        assertNoReal(r, [ip, segwit, eth, btc], 'the message');
        assert(
          /Server (?:192\.0\.2|198\.51\.100|203\.0\.113)\.\d+,/.test(r),
          'IP stand-in not in a documentation range',
        );
        assert(
          /wallet bc1q[a-z0-9]{38},/.test(r),
          'SegWit stand-in lost its format',
        );
        assert(
          /ETH 0x[0-9a-fA-F]{40},/.test(r),
          'Ethereum stand-in lost its format',
        );
        assert(
          /BTC 1[1-9A-HJ-NP-Za-km-z]{25,33},/.test(r),
          'Base58 stand-in lost its format',
        );
        assert(
          r.includes('router 192.168.1.20.'),
          'the private address was changed',
        );
        await tab.waitForText([ip, segwit, eth, btc]);
        await tab.reload();
        await tab.waitForText([ip, segwit, eth, btc]);
        return undefined;
      }),
  },
  {
    id: 'date-of-birth',
    title:
      'date of birth: shifted stand-in with the same age; a reply with a month name shows the real date',
    phase: 'P5.4',
    run: (h) => {
      const handler: ReplyHandler = (prompt) => {
        const m = /DOB (\d\d)\/(\d\d)\/(\d{4})/.exec(prompt);
        if (!m) return null;
        const [, day = '', month = '', year = ''] = m;
        return {
          text: `Your date of birth is ${Number(day).toString()} ${MONTHS[Number(month) - 1] ?? ''} ${year}.`,
        };
      };
      return withReplies(h, handler, () =>
        withTabs(async (track) => {
          const dob = real('14/07/1986');
          const tab = track(await h.openTab());
          const mark = h.logs.mark();
          const sent = await tab.send(
            `My DOB ${dob}, please fill in the form.`,
            {
              newChat: true,
            },
          );
          const m = /DOB (\d\d)\/(\d\d)\/(\d{4}),/.exec(sent.received);
          assert(m, 'the stand-in date lost its format');
          const [, d = '', mo = '', y = ''] = m;
          assert(`${d}/${mo}/${y}` !== dob, 'the date was not masked');
          const today = new Date();
          assert(
            ageOn(Number(d), Number(mo), Number(y), today) ===
              ageOn(14, 7, 1986, today),
            'the stand-in date changes the age',
          );
          await tab.waitForText(['14 July 1986']);
          await assertNoLeak(h, mark);
          await tab.reload();
          await tab.waitForText(['14 July 1986', dob]);
          return undefined;
        }),
      );
    },
  },
];
