/**
 * The spike's stand-in format, in a module of its own so the MAIN-world
 * request net can recognise stand-ins without bundling the detector.
 */
const SPIKE_STAND_IN = /^standin\.\d+(?:\.[a-z0-9]{1,8})?@example\.net$/i;

/**
 * True for an address in the spike's stand-in format. example.net is a
 * reserved documentation domain, so no real address has this form; stand-ins
 * from an earlier page load (before the vault exists) are recognised by it.
 */
export function isSpikeStandIn(email: string): boolean {
  return SPIKE_STAND_IN.test(email.trim());
}

/** The spike stand-in with this number and tag (1–8 lowercase letters or digits). */
export function spikeStandIn(number: number, tag: string): string {
  return `standin.${number.toString()}.${tag}@example.net`;
}
