import type { SiteNetRules } from '@/src/adapters/types.ts';
import {
  decideRequest,
  type FormMatcher,
  type NetKnowledge,
} from '@/src/core/net/checks.ts';
import { createFormHasher, normaliseValue } from '@/src/core/net/hash.ts';
import { createRollingHash, rollingBase } from '@/src/core/net/rolling.ts';
import { isSpikeStandIn } from '@/src/core/spike-standin.ts';
import type { NetCategory, NetTransport } from '@/src/shared/net-protocol.ts';
import { startMainChannel } from './channel.ts';
import { requestTexts, type DescribedRequest } from './request.ts';
import { originalFunction, wrapNetwork, type NetWindow } from './wrappers.ts';

/** Longest wait for the isolated side's verdict on a message request. */
export const VERIFY_TIMEOUT_MS = 10_000;

/**
 * The request safety net, installed in the page's own world at
 * document_start. It never holds a real value: only keyed hashes and keyed
 * rolling values of the forms of values the user masked, plus the email
 * stand-ins issued for them.
 *
 * Tier 1 (message endpoints): any email in the message text that is not a
 * stand-in blocks the request; a message request sent with fetch also waits
 * for the isolated side to run the full detector on its message text fields
 * (no verdict in time blocks it). Tier 2 (every request): any value the user
 * has masked in this tab, in any common writing, blocks the request,
 * whatever its destination.
 */
export function installNetGuard(
  win: NetWindow & { performance: { now(): number } },
  doc: Document,
  rules: SiteNetRules,
): void {
  const standIns = new Set<string>();
  const rollingByLength = new Map<number, Set<number>>();
  const formHashes = new Set<string>();
  let matcher: FormMatcher | null = null;
  const setTimer = originalFunction(win, 'setTimeout');
  const now = originalFunction(win.performance, 'now');

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

  /** The isolated side's verdict on a fetch message request's text. */
  const verify = async (
    parts: readonly string[],
    transport: NetTransport,
  ): Promise<boolean> => {
    const started = now.call(win.performance);
    const allowed = await channel.verify(parts, VERIFY_TIMEOUT_MS);
    const ms = now.call(win.performance) - started;
    channel.report({ event: 'net.verified', ms, block: !allowed });
    return allowed ? true : blocked(1, 'message', transport);
  };

  wrapNetwork(win, (request: DescribedRequest, transport) => {
    let category: NetCategory = 'other';
    try {
      const texts = requestTexts(request, rules);
      category = texts.message ? 'message' : 'other';
      if (request.body.skippedBinary) {
        channel.report({ event: 'net.skipped-binary', category, transport });
      }
      const verdict = decideRequest(texts, knowledge);
      if (verdict.block) return blocked(verdict.tier, category, transport);
      if (import.meta.env.DEV && category === 'message') {
        channel.report({ event: 'net.checked', category, transport });
      }
      // Only fetch can wait; the other transports keep the checks above.
      const parts = texts.messageParts;
      if (transport === 'fetch' && parts !== null && parts.length > 0) {
        return verify(parts, transport);
      }
      return true;
    } catch {
      // A request the net cannot inspect does not go out; the failure is
      // reported, never ignored.
      channel.report({ event: 'net.failed', category, transport });
      return false;
    }
  });
}
