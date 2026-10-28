/**
 * How much a valid phone reading proves, per region and digit length, from
 * the generated table (scripts/generate-phone-shares.ts). In a permissive
 * cell most random digit runs are valid numbers, so validity alone says
 * little about whether the text is a phone number.
 */
import type { CountryCode } from '../../../shared/country.ts';
import { PERMISSIVE_CELLS } from './phone-shares.generated.ts';

/** Built on first use, not at import. */
let permissive: ReadonlySet<string> | null = null;

/** True when phone validity in `region` at `digitCount` digits is near-uninformative. */
export function isPermissivePhoneCell(
  region: CountryCode,
  digitCount: number,
): boolean {
  permissive ??= new Set(PERMISSIVE_CELLS);
  return permissive.has(`${region}@${digitCount.toString()}`);
}
