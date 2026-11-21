import type { SiteNetRules } from '@/src/adapters/types.ts';
import {
  decideRequest,
  type FormMatcher,
  type NetKnowledge,
} from '@/src/core/net/checks.ts';
import { createFormHasher, normaliseValue } from '@/src/core/net/hash.ts';
import { createRollingHash, rollingBase } from '@/src/core/net/rolling.ts';
import { isSpikeStandIn } from '@/src/core/spike-standin.ts';
import type {
  NetCategory,
  NetTransport,
  NetWriteCheck,
  NetWriteResult,
} from '@/src/shared/net-protocol.ts';
import { captureCodecs, type BodyContent, type CodecGlobals } from './body.ts';
import { startMainChannel } from './channel.ts';
import {
  loggedPath,
  requestTexts,
  type DescribedRequest,
  type WriteDescription,
} from './request.ts';
import { originalFunction, wrapNetwork, type NetWindow } from './wrappers.ts';

/** Longest wait for the isolated side's verdict on a write's user text. */
export const VERIFY_TIMEOUT_MS = 10_000;

/** The body as the dev log describes it: json, gzip-json, binary, none, … */
function bodyKind(body: BodyContent, write: WriteDescription): string {
  const parts: string[] = [];
  if (body.encoding !== null) parts.push(body.encoding);
  if (body.texts.length > 0) {
    parts.push(body.form ? 'form' : write.json ? 'json' : 'text');
  }
  if (body.skipped !== null) parts.push(body.skipped);
  return parts.length === 0 ? 'none' : parts.join('-');
}

/**
 * Body reasons that block a first-party write: text that could not be read
 * (too large, or behind a gzip header that does not decompress) may carry
 * typed text the site would still receive.
 */
const UNREADABLE = new Set(['too-large', 'corrupt']);

/**
 * The request safety net, installed in the page's own world at
 * document_start. It never holds a real value: only keyed hashes and keyed
 * rolling values of the forms of values the user masked, plus the email
 * stand-ins issued for them.
 *
 * First-party writes (every request that sends data to the site itself,
 * any transport) have their user text checked, with the site's escaping
 * undone: tier 1 blocks any email that is not a stand-in (synchronous, all
 * transports); for fetch, which can wait, the isolated side then runs the
 * full detector on it, and no verdict in time blocks the request. Tier 2
 * (every request, any destination): any value the user has masked in this
 * tab, in any common writing, blocks the request.
 */
export function installNetGuard(
  win: NetWindow & CodecGlobals & { performance: { now(): number } },
  doc: Document,
  rules: SiteNetRules,
): void {
  const standIns = new Set<string>();
  const rollingByLength = new Map<number, Set<number>>();
  const formHashes = new Set<string>();
  let matcher: FormMatcher | null = null;
  const setTimer = originalFunction(win, 'setTimeout');
  const now = originalFunction(win.performance, 'now');
  const codecs = captureCodecs(win);

  const knowledge: NetKnowledge = {
    standIns,
    isStandIn: isSpikeStandIn,
    rollingByLength,
    formHashes,
    get matcher() {
      return matcher;
    },
  };

  const channel = startMainChannel(doc, {
    onKey(key) {
      matcher = {
        rolling: createRollingHash(rollingBase(key)),
        hash: createFormHasher(key),
      };
    },
    onAdd(addition) {
      for (const form of addition.forms) {
        let values = rollingByLength.get(form.length);
        if (values === undefined) {
          values = new Set();
          rollingByLength.set(form.length, values);
        }
        values.add(form.roll);
        formHashes.add(form.hash);
      }
      for (const s of addition.standIns) {
        standIns.add(normaliseValue('email', s));
      }
      // Confirms delivery, so a live test can tell whether tier 2 is armed.
      if (import.meta.env.DEV) {
        channel.report({ event: 'net.added', count: formHashes.size });
      }
    },
    setTimer(handler, ms) {
      Reflect.apply(setTimer, win, [handler, ms]);
    },
  });

  const blocked = (
    tier: 1 | 2,
    category: NetCategory,
    transport: NetTransport,
  ): false => {
    channel.report({ event: 'net.blocked', tier, category, transport });
    return false;
  };

  /** One dev-log line per first-party write: no values, ever. */
  const logWrite = (
    request: DescribedRequest,
    write: WriteDescription,
    transport: NetTransport,
    checked: NetWriteCheck,
    result: NetWriteResult,
  ): void => {
    if (!import.meta.env.DEV || request.url === null) return;
    channel.report({
      event: 'net.write',
      method: request.method,
      path: loggedPath(request.url),
      transport,
      category: write.surface,
      fields: [...write.fields],
      body: bodyKind(request.body, write),
      checked,
      result,
    });
  };

  /** The isolated side's full check of a fetch write's user text. */
  const verify = async (
    request: DescribedRequest,
    write: WriteDescription,
  ): Promise<boolean> => {
    const started = now.call(win.performance);
    const outcome = await channel.verify(write.user, VERIFY_TIMEOUT_MS);
    const ms = now.call(win.performance) - started;
    channel.report({ event: 'net.verified', ms, block: outcome.block });
    if (outcome.block) {
      logWrite(request, write, 'fetch', 'full', 'block');
      return blocked(1, write.surface, 'fetch');
    }
    logWrite(
      request,
      write,
      'fetch',
      'full',
      outcome.possible > 0 ? 'possible' : 'pass',
    );
    return true;
  };

  wrapNetwork(win, codecs, (request: DescribedRequest, transport) => {
    let category: NetCategory = 'other';
    try {
      const texts = requestTexts(request, rules);
      const { write } = texts;
      category = write?.surface ?? 'other';
      const { skipped } = request.body;
      if (skipped !== null) {
        channel.report({
          event: 'net.skipped-binary',
          category,
          transport,
          reason: skipped,
        });
      }
      const checked: NetWriteCheck =
        write === null || write.skipped
          ? 'skipped'
          : transport === 'fetch'
            ? 'full'
            : 'sync';
      if (write !== null && !write.skipped && skipped !== null) {
        if (UNREADABLE.has(skipped)) {
          logWrite(request, write, transport, checked, 'block');
          return blocked(1, category, transport);
        }
      }
      const verdict = decideRequest(
        {
          all: texts.all,
          user: write === null || write.skipped ? null : write.user,
        },
        knowledge,
      );
      if (verdict.block) {
        if (write !== null)
          logWrite(request, write, transport, checked, 'block');
        return blocked(verdict.tier, category, transport);
      }
      if (write === null) return true;
      if (import.meta.env.DEV && category === 'message') {
        channel.report({ event: 'net.checked', category, transport });
      }
      // Only fetch can wait; the other transports keep the checks above.
      if (checked === 'full' && write.user.length > 0) {
        return verify(request, write);
      }
      logWrite(request, write, transport, checked, 'pass');
      return true;
    } catch {
      // A request the net cannot inspect does not go out; the failure is
      // reported, never ignored.
      channel.report({ event: 'net.failed', category, transport });
      return false;
    }
  });
}
