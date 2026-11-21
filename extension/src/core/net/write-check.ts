/**
 * The full check of the user text in a first-party write (the isolated
 * side's answer to the request safety net's verify request).
 *
 * Saves from editors on the site (e.g. ChatGPT's writing blocks) can fire on
 * every keystroke with the whole text, so the text is checked paragraph by
 * paragraph (split at blank lines), each with enough of its neighbours
 * around it for every rule's context window. A keystroke changes one
 * paragraph's window; the others are found again in the scanner's cache.
 *
 * A detection counts for the paragraph it starts in, so a value near a
 * paragraph boundary is counted once.
 */
import type { Detection } from '../../shared/entities.ts';

/**
 * Text kept on each side of a paragraph: at least the widest context
 * window of any rule (48 characters before, 24 after).
 */
export const CONTEXT_CHARS = 64;

export interface ParagraphWindow {
  /** The paragraph with up to CONTEXT_CHARS of text on each side. */
  readonly text: string;
  /** Where the paragraph itself starts and ends inside `text`. */
  readonly start: number;
  readonly end: number;
}

const BLANK_LINE = /\n[^\S\n]*\n/g;

/** The paragraphs of `text` (split at blank lines) with their context. */
export function paragraphWindows(text: string): ParagraphWindow[] {
  const bounds: [number, number][] = [];
  let from = 0;
  for (const match of text.matchAll(BLANK_LINE)) {
    bounds.push([from, match.index]);
    from = match.index + match[0].length;
  }
  bounds.push([from, text.length]);
  const out: ParagraphWindow[] = [];
  for (const [start, end] of bounds) {
    if (start === end) continue;
    const lead = Math.max(0, start - CONTEXT_CHARS);
    const trail = Math.min(text.length, end + CONTEXT_CHARS);
    out.push({
      text: text.slice(lead, trail),
      start: start - lead,
      end: end - lead,
    });
  }
  return out;
}

export interface WriteCheckResult {
  /** A confirmed value that is not a stand-in: the request must not go. */
  readonly block: boolean;
  /** "possible" detections of masked types (logged, never blocked). */
  readonly possible: number;
}

export interface WriteCheckOptions {
  /** The detector, on one window (cached by exact text by the caller). */
  readonly scan: (text: string) => Promise<readonly Detection[]>;
  /** The send pipeline's rule: confirmed, a masked type, not a stand-in. */
  readonly needsMasking: (detection: Detection) => boolean;
  /** True for a type the user has switched on. */
  readonly isMaskedType: (detection: Detection) => boolean;
}

/**
 * Checks every text; stops at the first value that blocks. Any failure of
 * the scanner rejects, and the caller blocks the request.
 */
export async function checkUserTexts(
  texts: readonly string[],
  options: WriteCheckOptions,
): Promise<WriteCheckResult> {
  let possible = 0;
  for (const text of texts) {
    for (const window of paragraphWindows(text)) {
      const found = await options.scan(window.text);
      for (const detection of found) {
        if (detection.start < window.start || detection.start >= window.end) {
          continue;
        }
        if (options.needsMasking(detection)) return { block: true, possible };
        if (
          detection.status === 'possible' &&
          options.isMaskedType(detection)
        ) {
          possible += 1;
        }
      }
    }
  }
  return { block: false, possible };
}
