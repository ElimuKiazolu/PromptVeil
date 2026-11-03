import { devlog } from '@/src/shared/devlog.ts';
import { noticeEnvelope } from '@/src/shared/messaging.ts';
import type { VaultNotice } from '@/src/shared/vault-protocol.ts';
import { VAULT_SITE_TABS } from './sites.ts';

/** The tabs API this module needs; `browser.tabs` satisfies it. */
export interface TabsLike {
  query(info: { url: string[] }): Promise<{ id?: number }[]>;
  sendMessage(tabId: number, message: unknown): Promise<unknown>;
}

/**
 * Sends a notice to every tab showing a vault site, except `exceptTabId`
 * (the tab that caused it, which already knows). Never rejects: a tab
 * without our content script (opened before the extension was installed or
 * reloaded) cannot receive it, which is counted in the dev log.
 */
export async function notifyTabs(
  tabs: TabsLike,
  notice: VaultNotice,
  exceptTabId?: number,
): Promise<void> {
  let targets: { id?: number }[];
  try {
    targets = await tabs.query({ url: [...VAULT_SITE_TABS] });
  } catch (error) {
    devlog('notice.failed', { error });
    return;
  }
  const envelope = noticeEnvelope(notice);
  const results = await Promise.allSettled(
    targets
      .map((tab) => tab.id)
      .filter((id): id is number => id !== undefined && id !== exceptTabId)
      .map((id) => tabs.sendMessage(id, envelope)),
  );
  const failed = results.filter((result) => result.status === 'rejected');
  if (failed.length > 0) devlog('notice.failed', { count: failed.length });
}
