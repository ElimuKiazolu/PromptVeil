/**
 * The rules stage of draft analysis, and its warm-up and cache control.
 */
import type { CountryCode } from '../../../shared/country.ts';
import type { Detection, EntityType } from '../../../shared/entities.ts';
import type { Analyse } from '../../draft/analyzer.ts';
import type { Checkpoint } from '../schedule.ts';
import { clearPhoneCache, warmUpPhone } from '../validators/phone.ts';
import { detectRules } from './detector.ts';
import type { CountryPack } from './packs/index.ts';

export interface RulesConfig {
  readonly homeRegions: readonly CountryCode[];
  readonly preferredRegions: readonly CountryCode[];
  readonly entityTypes: ReadonlySet<EntityType>;
  readonly packs: readonly CountryPack[];
}

/** Detects with the rules only; nothing is excluded at this stage. */
export function rulesAnalysis(config: RulesConfig): Analyse<Detection[]> {
  return (text, checkpoint) =>
    detectRules(text, { ...config, exclude: [], checkpoint });
}

/** Sample text (documentation values only) that runs every global rule once. */
const WARM_UP_TEXT =
  'Mail test@example.com, call +44 20 7946 0018, card 4242 4242 4242 4242, ' +
  'IBAN GB29 NWBK 6016 1331 9268 19, token: Xq7Lp2Rv9KtB4mWz8NcY3sHd6FgJ1uAe';

/**
 * Prepares the rules so the first real Send is not slow: compiles their
 * patterns and builds the phone pre-check index, in slices. Caches nothing
 * from the sample.
 */
export async function warmUpRules(checkpoint: Checkpoint): Promise<void> {
  await warmUpPhone(checkpoint);
  await detectRules(WARM_UP_TEXT, {
    homeRegions: [],
    entityTypes: new Set<EntityType>([
      'EMAIL',
      'PHONE',
      'CARD',
      'BANK',
      'SECRET',
    ]),
    packs: [],
    exclude: [],
    checkpoint,
  });
}

/** Forgets cached validator results; they can hold real values. */
export function clearRuleCaches(): void {
  clearPhoneCache();
}
