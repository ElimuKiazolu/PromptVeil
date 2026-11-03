/**
 * Sites whose content scripts use the vault, by page origin. A site is added
 * here when its adapter is wired to the vault.
 */
import type { MessageSenderLike } from '@/src/shared/messaging.ts';
import type { SiteId } from '@/src/shared/settings.ts';

const SITE_ORIGINS: readonly (readonly [SiteId, string])[] = [
  ['chatgpt', 'https://chatgpt.com'],
];

/** Tab URL patterns of every vault site (tabs.query). */
export const VAULT_SITE_TABS: readonly string[] = SITE_ORIGINS.map(
  ([, origin]) => `${origin}/*`,
);

/**
 * The site a message came from: only a top-level frame of a tab showing one
 * of the sites counts, so other extension contexts, iframes and other pages
 * are refused.
 */
export function senderSite(sender: MessageSenderLike): SiteId | null {
  if (sender.tab?.id === undefined || sender.frameId !== 0) return null;
  if (sender.url === undefined) return null;
  let origin: string;
  try {
    origin = new URL(sender.url).origin;
  } catch {
    return null;
  }
  return (
    SITE_ORIGINS.find(([, siteOrigin]) => siteOrigin === origin)?.[0] ?? null
  );
}
