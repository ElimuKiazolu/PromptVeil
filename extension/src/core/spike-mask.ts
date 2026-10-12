/**
 * Spike transform for P1 only: proves send interception end to end with
 * email addresses. It is replaced by the stand-in engine (P2–P5), which
 * covers every entity type and keeps mappings in the encrypted vault.
 *
 * Mappings live only in this closure for the life of the page.
 */
import { detectEmails } from './detect/rules/email.ts';

export type Masker = (text: string) => string;

export function createSpikeMasker(): Masker {
  const standIns = new Map<string, string>();
  const issued = new Set<string>();

  const standInFor = (email: string): string => {
    const key = email.toLowerCase();
    let standIn = standIns.get(key);
    if (standIn === undefined) {
      standIn = `standin.${(standIns.size + 1).toString()}@example.net`;
      standIns.set(key, standIn);
      issued.add(standIn);
    }
    return standIn;
  };

  return (text) => {
    let out = '';
    let cursor = 0;
    for (const span of detectEmails(text)) {
      out += text.slice(cursor, span.start);
      // A stand-in already issued here (edited or regenerated message) is
      // left as it is rather than masked a second time.
      out += issued.has(span.value.toLowerCase())
        ? span.value
        : standInFor(span.value);
      cursor = span.end;
    }
    return out + text.slice(cursor);
  };
}
