import {
  CLEANUP_ALARM,
  deleteEverything,
  ensureCleanupAlarm,
  runCleanup,
  type MaintenanceDeps,
} from '@/src/background/maintenance.ts';
import { registerVaultHandlers } from '@/src/background/vault-host.ts';
import { startBenchOffscreenHost } from '@/src/dev/bench/background.ts';
import { VaultError } from '@/src/core/vault/errors.ts';
import { createVaultService } from '@/src/core/vault/service.ts';
import { devlog } from '@/src/shared/devlog.ts';
import { createMessenger, PROTOCOL } from '@/src/shared/messaging.ts';

function reportFailure(error: unknown): void {
  devlog('vault.failed', {
    error,
    ...(error instanceof VaultError ? { vault: error.code } : {}),
  });
}

export default defineBackground(() => {
  // Benchmark builds only (modes from wxt.config.ts). The mode is a build-time
  // constant, so other builds drop this branch and the benchmark code.
  if (
    import.meta.env.MODE === 'bench' ||
    import.meta.env.MODE === 'bench-nocoi'
  ) {
    startBenchOffscreenHost();
  }

  // The service worker owns the vault database; content scripts never open it.
  const vault = createVaultService({ idb: indexedDB, crypto });
  const deps: MaintenanceDeps = {
    vault,
    storage: browser.storage.local,
    tabs: browser.tabs,
  };

  // Listeners are registered at the top level, so the events wake the worker.
  registerVaultHandlers({
    messenger: createMessenger(PROTOCOL, browser.runtime),
    vault,
    tabs: browser.tabs,
  });

  const cleanUp = (): void => {
    runCleanup(deps).catch(reportFailure);
  };

  // Keys are created on install; operations also create them lazily if missing.
  browser.runtime.onInstalled.addListener(() => {
    vault.ensureKeys().then((state) => {
      devlog(state.status === 'ready' ? 'vault.ready' : 'vault.keys-lost');
    }, reportFailure);
    ensureCleanupAlarm(browser.alarms).catch(reportFailure);
  });

  // Auto-delete at browser start and daily; alarms are not guaranteed to
  // survive a browser restart, so the start also schedules it again.
  browser.runtime.onStartup.addListener(() => {
    ensureCleanupAlarm(browser.alarms).catch(reportFailure);
    cleanUp();
  });
  browser.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === CLEANUP_ALARM) cleanUp();
  });

  // Development builds only: delete-all and cleanup from the service
  // worker's console (`await promptveilDev.deleteAll()`), until the options
  // page offers them. Production builds drop this block.
  if (import.meta.env.DEV) {
    Object.assign(globalThis, {
      promptveilDev: {
        deleteAll: () => deleteEverything(deps).then((state) => state.status),
        cleanUp: () =>
          runCleanup(deps).then((result) => ({
            conversations: result.conversations.length,
            mappings: result.mappings,
            logRows: result.logRows,
          })),
      },
    });
  }
});
