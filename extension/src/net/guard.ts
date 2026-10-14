import type { SiteNetRules } from '@/src/adapters/types.ts';
import { decideRequest, type NetKnowledge } from '@/src/core/net/checks.ts';
import {
  createValueHasher,
  normaliseValue,
  type ValueHasher,
} from '@/src/core/net/hash.ts';
import { isSpikeStandIn } from '@/src/core/spike-mask.ts';
import { startMainChannel } from './channel.ts';
import { requestTexts } from './request.ts';
import { wrapNetwork, type NetWindow } from './wrappers.ts';

/**
 * The request safety net, installed in the page's own world at
 * document_start. It never holds a real value: only keyed hashes of the
 * values the user masked, plus the stand-ins issued for them.
 *
 * Tier 1 (message endpoints): any email in the message text that is not a
 * stand-in blocks the request. Tier 2 (every request): any value the user
 * has masked in this tab blocks the request, whatever its destination.
 */
export function installNetGuard(
  win: NetWindow,
  doc: Document,
  rules: SiteNetRules,
): void {
  const standIns = new Set<string>();
  const realValueHashes = new Set<string>();
  let hash: ValueHasher | null = null;

  const knowledge: NetKnowledge = {
    standIns,
    realValueHashes,
    isStandIn: isSpikeStandIn,
    get hash() {
      return hash;
    },
  };

  const channel = startMainChannel(doc, {
    onKey(key) {
      hash = createValueHasher(key);
    },
    onAdd(addition) {
      for (const h of addition.hashes) realValueHashes.add(h);
      for (const s of addition.standIns) {
        standIns.add(normaliseValue('email', s));
      }
    },
  });

  wrapNetwork(win, (request, transport) => {
    let category: 'message' | 'other' = 'other';
    try {
      const texts = requestTexts(request, rules);
      category = texts.message ? 'message' : 'other';
      if (request.body.skippedBinary) {
        channel.report({ event: 'net.skipped-binary', category, transport });
      }
      const verdict = decideRequest(texts, knowledge);
      if (verdict.block) {
        channel.report({
          event: 'net.blocked',
          tier: verdict.tier,
          category,
          transport,
        });
        return false;
      }
      if (import.meta.env.DEV && category === 'message') {
        channel.report({ event: 'net.checked', category, transport });
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
