/**
 * Development diagnostics: after a conversation loads, counts the stand-ins
 * still visible in its messages once the restorer has had time to run, and
 * says why (`restore.unrestored count=N <reason>`): counts and codes only.
 *
 * Stand-ins the session knows are found by the restore matcher; email
 * stand-ins it does not know (the vault returned no mapping for them) are
 * found by their reserved domains. Editors on the page are skipped: they
 * keep stand-ins by design (D-017).
 */
import type { SiteAdapter } from '@/src/adapters/types.ts';
import { createRestoreMatcher } from '@/src/core/restore/index.ts';
import type { StandInSource } from '@/src/core/restore/types.ts';
import { devlog, type DevReason } from '@/src/shared/devlog.ts';

/** How a conversation's load ended. */
export interface LoadOutcome {
  readonly status: 'ready' | 'keys-lost' | 'error';
  /** Mappings the vault returned. */
  readonly mappings: number;
  /** Stored mappings that could not be read. */
  readonly failed: number;
}

/** Time for the restorer to finish (its quiet period is 1.5 s). */
export const UNRESTORED_DELAY_MS = 2_500;

/** Email stand-ins are always on these reserved domains (RFC 2606). */
const RESERVED_EMAIL =
  /[\p{L}\p{N}._%+-]+@example\.(?:com|org|net)(?![\p{L}\p{N}.-])/giu;
const EDITOR = '[contenteditable="true"], [contenteditable=""], .ProseMirror';

/** A message's text, without text inside editors (cards keep stand-ins). */
function textOutsideEditors(el: Element): string {
  const walker = el.ownerDocument.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let text = '';
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    if (node.parentElement?.closest(EDITOR) == null) {
      text += node.nodeValue ?? '';
    }
  }
  return text;
}

export function unrestoredReason(outcome: LoadOutcome): DevReason {
  if (outcome.status === 'keys-lost') return 'keys-lost';
  if (outcome.status === 'error') return 'load-failed';
  if (outcome.failed > 0) return 'decrypt-failed';
  if (outcome.mappings === 0) return 'no-mappings';
  return 'no-match';
}

/** Visible stand-ins in message texts: known ones and unknown email ones. */
export function countUnrestored(
  texts: readonly string[],
  source: StandInSource,
): number {
  const mappings = source.mappings();
  // Restored real values on these domains are not stand-ins either.
  const known = new Set(
    mappings.flatMap((m) => [m.standIn.toLowerCase(), m.real.toLowerCase()]),
  );
  const matcher = createRestoreMatcher(mappings);
  let count = 0;
  for (const text of texts) {
    count += matcher.countOccurrences(text);
    for (const match of text.matchAll(RESERVED_EMAIL)) {
      if (!known.has(match[0].toLowerCase())) count += 1;
    }
  }
  return count;
}

export function createUnrestoredCheck(options: {
  adapter: Pick<SiteAdapter, 'getMessageContainers'>;
  source: StandInSource;
  signal: AbortSignal;
  delayMs?: number;
}): (outcome: LoadOutcome) => void {
  const delay = options.delayMs ?? UNRESTORED_DELAY_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  options.signal.addEventListener(
    'abort',
    () => {
      clearTimeout(timer);
    },
    { once: true },
  );
  return (outcome) => {
    clearTimeout(timer);
    if (options.signal.aborted) return;
    timer = setTimeout(() => {
      const texts = options.adapter
        .getMessageContainers()
        .map(textOutsideEditors);
      const count = countUnrestored(texts, options.source);
      if (count > 0) {
        devlog('restore.unrestored', {
          count,
          reason: unrestoredReason(outcome),
        });
      }
    }, delay);
  };
}
