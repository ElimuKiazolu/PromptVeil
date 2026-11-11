/**
 * The service worker's vault requests (see src/shared/vault-protocol.ts).
 *
 * Every conversation ID must belong to the site of the sending tab, so a
 * content script on one site can never read or write another site's
 * mappings. Replies carry real values only to the tab that asked; other
 * tabs get notices without values.
 */
import { toBase64 } from '@/src/core/vault/encoding.ts';
import { VaultError } from '@/src/core/vault/errors.ts';
import type { VaultService } from '@/src/core/vault/service.ts';
import { parseConversationId } from '@/src/shared/conversation-id.ts';
import { devlog } from '@/src/shared/devlog.ts';
import type {
  MessageSenderLike,
  Messenger,
  Protocol,
} from '@/src/shared/messaging.ts';
import type { VaultFailure } from '@/src/shared/vault-protocol.ts';
import { senderSite } from './sites.ts';
import { notifyTabs, type TabsLike } from './tab-notices.ts';

export interface VaultHostDeps {
  messenger: Messenger<Protocol>;
  vault: VaultService;
  tabs: TabsLike;
}

const FORBIDDEN: VaultFailure = { status: 'error', code: 'forbidden' };

/** The conversation, if the sender's site may use it. */
function allowed(sender: MessageSenderLike, conversationId: string) {
  const site = senderSite(sender);
  const parsed = parseConversationId(conversationId);
  if (site === null || parsed?.site !== site) {
    devlog('vault.forbidden');
    return null;
  }
  return parsed;
}

/** A vault failure as a reply; anything else is a bug and propagates. */
function failure(error: unknown): VaultFailure {
  if (!(error instanceof VaultError)) throw error;
  devlog('vault.failed', { error, vault: error.code });
  return error.code === 'keys-lost'
    ? { status: 'keys-lost' }
    : { status: 'error', code: error.code };
}

/** Registers the vault handlers; returns their removal. */
export function registerVaultHandlers({
  messenger,
  vault,
  tabs,
}: VaultHostDeps): () => void {
  const changed = (conversationId: string, sender: MessageSenderLike): void => {
    void notifyTabs(
      tabs,
      { name: 'vault.changed', conversationId },
      sender.tab?.id,
    );
  };

  const removals = [
    messenger.handle('vault.prepare', async (request, sender) => {
      const conversation = allowed(sender, request.conversationId);
      if (conversation === null) return FORBIDDEN;
      try {
        const result = await vault.prepareMask({
          conversationId: request.conversationId,
          site: conversation.site,
          status: conversation.kind === 'pending' ? 'pending' : 'active',
          items: request.items,
        });
        return {
          status: 'ok',
          dateOffsetDays: result.dateOffsetDays,
          items: result.values.map((value) =>
            value.kind === 'existing'
              ? value
              : {
                  kind: 'new',
                  seed: toBase64(value.seed),
                  number: value.number,
                },
          ),
        };
      } catch (error) {
        return failure(error);
      }
    }),

    messenger.handle('vault.commit', async (request, sender) => {
      const conversation = allowed(sender, request.conversationId);
      if (conversation === null) return FORBIDDEN;
      try {
        const result = await vault.commitMask(
          request.conversationId,
          request.entries.map((entry) => ({
            real: entry.item,
            standIn: entry.standIn,
            standInNormalised: entry.standInNormalised,
          })),
        );
        devlog('vault.masked', { count: result.inserted });
        // A pending chat belongs to this tab alone.
        if (result.inserted > 0 && conversation.kind === 'active') {
          changed(request.conversationId, sender);
        }
        return { status: 'ok', items: result.values };
      } catch (error) {
        return failure(error);
      }
    }),

    messenger.handle('vault.load', async (request, sender) => {
      if (allowed(sender, request.conversationId) === null) return FORBIDDEN;
      try {
        const loaded = await vault.loadConversation(request.conversationId);
        devlog('vault.loaded', { count: loaded.entries.length });
        if (loaded.failed > 0) {
          devlog('vault.load-failed', { count: loaded.failed });
        }
        return {
          status: 'ok',
          mappings: loaded.entries.map((entry) => ({
            standIn: entry.surrogate,
            real: entry.real,
            type: entry.type,
          })),
          failed: loaded.failed,
        };
      } catch (error) {
        return failure(error);
      }
    }),

    messenger.handle('vault.migrate', async (request, sender) => {
      const from = allowed(sender, request.from);
      const to = allowed(sender, request.to);
      if (
        from === null ||
        to === null ||
        from.kind !== 'pending' ||
        to.kind !== 'active'
      ) {
        return FORBIDDEN;
      }
      try {
        const outcome = await vault.migrate(request.from, request.to);
        if (outcome.status === 'nothing') return { status: 'nothing' };
        devlog('vault.migrated', { count: outcome.count });
        if (outcome.dropped > 0) {
          devlog('vault.load-failed', { count: outcome.dropped });
        }
        changed(request.to, sender);
        return { status: 'migrated', count: outcome.count };
      } catch (error) {
        return failure(error);
      }
    }),
  ];

  return () => {
    for (const remove of removals) remove();
  };
}
