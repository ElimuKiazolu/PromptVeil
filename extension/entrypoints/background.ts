import { startBenchOffscreenHost } from '@/src/dev/bench/background.ts';
import { VaultError } from '@/src/core/vault/errors.ts';
import { createVaultService } from '@/src/core/vault/service.ts';
import { devlog } from '@/src/shared/devlog.ts';

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

  // Keys are created on install; operations also create them lazily if missing.
  browser.runtime.onInstalled.addListener(() => {
    vault.ensureKeys().then(
      (state) => {
        devlog(state.status === 'ready' ? 'vault.ready' : 'vault.keys-lost');
      },
      (error: unknown) => {
        devlog('vault.failed', {
          error,
          ...(error instanceof VaultError ? { vault: error.code } : {}),
        });
      },
    );
  });
});
