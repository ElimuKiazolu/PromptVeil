/**
 * EMAIL stand-ins keep the spike format until P5.2 (names and providers):
 * `standin.<n>.<tag>@example.net`, n the mapping's number (+ attempt) and a
 * four-character tag drawn from the seed, so a stand-in pasted from another
 * conversation does not match one issued here. example.net is reserved for
 * documentation (RFC 2606).
 */
import { spikeStandIn } from '../spike-standin.ts';
import { DIGITS, LOWER } from './rng.ts';
import type { Generator } from './types.ts';

const TAG_LENGTH = 4;

export const emailStandIn: Generator = ({ request, rng, attempt }) => ({
  value: spikeStandIn(
    request.number + attempt,
    rng.chars(LOWER + DIGITS, TAG_LENGTH),
  ),
  reserved: true,
});
