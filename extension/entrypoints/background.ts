import { startBenchOffscreenHost } from '@/src/dev/bench/background.ts';

export default defineBackground(() => {
  // Benchmark builds only (modes from wxt.config.ts). The mode is a build-time
  // constant, so other builds drop this branch and the benchmark code.
  if (
    import.meta.env.MODE === 'bench' ||
    import.meta.env.MODE === 'bench-nocoi'
  ) {
    startBenchOffscreenHost();
  }
  // Background logic is registered here as features land.
});
