/**
 * The final audit (always last): no real value used by any check reached
 * the site in any request (decoded, unescaped, compacted) or appears in any
 * log line of the pages or the service worker; first-party write lines name
 * what happened without values.
 */
import { compact, usedValues } from '../support/values.ts';
import { assert, carries, type Check } from './common.ts';

/** The URL %-decoded; a malformed escape leaves it as written. */
function decoded(url: string): string {
  try {
    return decodeURIComponent(url);
  } catch (error) {
    if (error instanceof URIError) return url;
    throw error;
  }
}

/** The fixed form of a net.write dev line (see src/shared/devlog.ts). */
const WRITE_LINE =
  /^\[PromptVeil\] dev \w{4} net\.write category=[a-z-]+ transport=[a-z]+ method=[A-Z]+ path=[A-Za-z0-9/:_.-]* fields=[A-Za-z0-9_.?,-]* body=[a-z-]+ checked=(?:full|sync|skipped) result=(?:pass|block|possible)$/;

export const auditCheck: Check = {
  id: 'audit',
  title:
    'no real value in any request or log line; write lines carry no values',
  phase: 'P5.1',
  run(h) {
    const values = usedValues();
    for (const request of h.site.requests) {
      const text = `${request.url} ${decoded(request.url)} ${request.body}`;
      const found = values.filter((value) => carries(text, value));
      assert(
        found.length === 0,
        `a real value reached the site in ${request.method} ${request.url.split('?')[0] ?? ''}`,
      );
    }
    for (const line of h.logs.lines) {
      const leaked = values.some(
        (value) =>
          line.text.includes(value) ||
          compact(line.text).includes(compact(value)),
      );
      assert(!leaked, `a real value in a ${line.source} log line`);
    }
    // Write lines carry fixed codes, key names and paths only.
    for (const line of h.logs.matching(/ net\.write /)) {
      assert(
        WRITE_LINE.test(line.text),
        'a net.write line is not in its fixed form',
      );
    }
    return Promise.resolve(
      `${h.site.requests.length.toString()} requests, ${h.logs.lines.length.toString()} log lines, ${values.length.toString()} values`,
    );
  },
};
