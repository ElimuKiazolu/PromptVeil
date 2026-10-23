import type { SiteAdapter } from '@/src/adapters/types.ts';
import {
  createRestoreMatcher,
  type Replacement,
  type RestoreMatcher,
  type StandInSource,
} from '@/src/core/restore/index.ts';
import { devlog } from '@/src/shared/devlog.ts';

export interface RestorerOptions {
  adapter: SiteAdapter;
  source: StandInSource;
  /** Disconnects the observer and cancels pending work when aborted. */
  signal: AbortSignal;
  /**
   * Subtree to observe. Defaults to the document element, which exists even
   * at document_start, before <body> does.
   */
  root?: Node;
  /** Quiet time after which a reply counts as finished. */
  quietMs?: number;
}

const DEFAULT_QUIET_MS = 1500;

/** Inserted between blocks so stand-ins never match across them. */
const SEPARATOR = '\n';

const BLOCK_TAGS = new Set([
  'ARTICLE',
  'BLOCKQUOTE',
  'DD',
  'DIV',
  'DL',
  'DT',
  'FIGCAPTION',
  'H1',
  'H2',
  'H3',
  'H4',
  'H5',
  'H6',
  'LI',
  'OL',
  'P',
  'PRE',
  'SECTION',
  'TABLE',
  'TD',
  'TH',
  'TR',
  'UL',
]);

const SKIP_TAGS = new Set([
  'INPUT',
  'NOSCRIPT',
  'SCRIPT',
  'STYLE',
  'TEMPLATE',
  'TEXTAREA',
]);

/**
 * Protected surfaces: text the user can edit (composer, edit boxes) and any
 * subtree a rich-text editor manages, editable at the moment or not (an
 * editor switched to read-only keeps its root class). An editor treats DOM
 * changes inside it as user edits and may save or sync them to the site, so
 * nothing in these is ever rewritten: stand-ins stay, and are counted apart
 * from leaks.
 */
const PROTECTED = [
  '[contenteditable]:not([contenteditable="false"])',
  'textarea',
  'input',
  // ProseMirror, Lexical, Slate, CodeMirror 6, Monaco, Quill.
  '.ProseMirror',
  '[data-lexical-editor]',
  '[data-slate-editor]',
  '.cm-editor',
  '.monaco-editor',
  '.ql-editor',
].join(', ');

function isProtected(node: Node): boolean {
  const el = node instanceof Element ? node : node.parentElement;
  return el?.closest(PROTECTED) != null;
}

/** Outermost protected surfaces in or around `root`. */
function protectedSurfaces(root: Element): Element[] {
  const around = root.closest(PROTECTED);
  if (around) return [around];
  return Array.from(root.querySelectorAll(PROTECTED)).filter(
    (el) => el.parentElement?.closest(PROTECTED) == null,
  );
}

interface TextSegment {
  node: Text;
  start: number;
  end: number;
}

interface CollectedText {
  text: string;
  segments: TextSegment[];
}

/** The text of `root` as one string, with each text node's span in it. */
function collect(root: Element): CollectedText {
  let text = '';
  const segments: TextSegment[] = [];
  const separate = (): void => {
    if (text !== '' && !text.endsWith(SEPARATOR)) text += SEPARATOR;
  };
  const walk = (parent: Node): void => {
    for (const child of Array.from(parent.childNodes)) {
      if (child instanceof Text) {
        const value = child.nodeValue ?? '';
        segments.push({
          node: child,
          start: text.length,
          end: text.length + value.length,
        });
        text += value;
      } else if (child instanceof Element) {
        if (
          SKIP_TAGS.has(child.tagName) ||
          child.tagName === 'BR' ||
          child.matches(PROTECTED)
        ) {
          separate();
          continue;
        }
        const block = BLOCK_TAGS.has(child.tagName);
        if (block) separate();
        walk(child);
        if (block) separate();
      }
    }
  };
  if (!root.closest(PROTECTED)) walk(root);
  return { text, segments };
}

/**
 * Writes the replacements into the existing text nodes. Each real value goes
 * into the node where its stand-in starts; characters of the stand-in that
 * spilled into later nodes are removed from those nodes. Only nodeValue is
 * changed, so the page's own element tree stays exactly as rendered.
 */
function applyReplacements(
  collected: CollectedText,
  replacements: readonly Replacement[],
  written: WeakMap<Text, string>,
): void {
  for (const segment of collected.segments) {
    let out = '';
    let pos = segment.start;
    let touched = false;
    for (const r of replacements) {
      if (r.end <= segment.start || r.start >= segment.end) continue;
      touched = true;
      out += collected.text.slice(pos, Math.max(r.start, pos));
      if (r.start >= segment.start) out += r.real;
      pos = Math.min(r.end, segment.end);
    }
    // A surface can turn into an editor between collecting and writing.
    if (!touched || isProtected(segment.node)) continue;
    out += collected.text.slice(pos, segment.end);
    if (out !== segment.node.nodeValue) {
      written.set(segment.node, out);
      segment.node.nodeValue = out;
    }
  }
}

/** The last non-empty text node under `root`, searching from the end. */
function lastTextIn(root: Node): Text | null {
  for (let n = root.lastChild; n !== null; n = n.previousSibling) {
    if (n instanceof Text) {
      if (n.nodeValue) return n;
      continue;
    }
    const inner = lastTextIn(n);
    if (inner) return inner;
  }
  return null;
}

function blockOf(node: Node, container: HTMLElement): Element {
  let el = node instanceof Element ? node : node.parentElement;
  while (el && el !== container && !BLOCK_TAGS.has(el.tagName)) {
    el = el.parentElement;
  }
  return el ?? container;
}

/**
 * Shows real values in place of stand-ins in the conversation, including
 * while replies stream, without changing the page's element structure.
 *
 * Work is batched per animation frame and limited to the blocks that
 * changed. Our own writes are recognised and ignored, so the observer never
 * feeds itself; if the page writes a stand-in back, it is restored again.
 */
export function startRestorer({
  adapter,
  source,
  signal,
  root = document.documentElement,
  quietMs = DEFAULT_QUIET_MS,
}: RestorerOptions): void {
  if (signal.aborted) return;

  let matcher: RestoreMatcher = createRestoreMatcher([]);
  let matcherVersion = -1;
  const pending = new Set<Element>();
  const writtenText = new WeakMap<Text, string>();
  const writtenHref = new WeakMap<Element, string>();
  const settled = new WeakSet<HTMLElement>();
  const quietTimers = new Map<HTMLElement, ReturnType<typeof setTimeout>>();
  /** Stand-ins last reported per protected surface. */
  const protectedCounts = new WeakMap<Element, number>();
  let frame: number | null = null;

  const isSettled = (container: HTMLElement): boolean =>
    !adapter.isAssistantMessage(container) || settled.has(container);

  const restoreLinks = (block: Element): void => {
    const anchors = Array.from(block.querySelectorAll('a[href]'));
    if (block instanceof HTMLAnchorElement) anchors.push(block);
    for (const anchor of anchors) {
      if (isProtected(anchor)) continue;
      const href = anchor.getAttribute('href') ?? '';
      if (!/^mailto:/i.test(href)) continue;
      const found = matcher.find(href);
      if (found.length === 0) continue;
      let next = '';
      let cursor = 0;
      for (const r of found) {
        next += href.slice(cursor, r.start) + r.real;
        cursor = r.end;
      }
      next += href.slice(cursor);
      writtenHref.set(anchor, next);
      anchor.setAttribute('href', next);
    }
  };

  /** Restores one block; returns how many stand-ins were replaced. */
  const restoreBlock = (block: Element, container: HTMLElement): number => {
    const collected = collect(block);
    let found = matcher.find(collected.text);
    if (!isSettled(container)) {
      // While a reply streams, its final word may still be growing; a
      // stand-in that ends exactly there waits until the reply settles.
      const last = lastTextIn(container);
      const tail = collected.segments.find((s) => s.node === last);
      if (tail) found = found.filter((r) => r.end < tail.end);
    }
    if (found.length > 0) applyReplacements(collected, found, writtenText);
    restoreLinks(block);
    return found.length;
  };

  /** Rebuilds the matcher if mappings changed; true when it did. */
  const refreshMatcher = (): boolean => {
    if (source.version === matcherVersion) return false;
    matcherVersion = source.version;
    matcher = createRestoreMatcher(source.mappings());
    // New mappings may apply to text that is already on screen.
    for (const container of adapter.getMessageContainers()) {
      pending.add(container);
    }
    return true;
  };

  /**
   * Reports stand-ins left in the protected surfaces of a settled message,
   * once per surface and only when the number changed. Not a leak: those
   * surfaces are deliberately left alone.
   */
  const reportProtected = (container: HTMLElement): void => {
    for (const surface of protectedSurfaces(container)) {
      const count = matcher.countOccurrences(surface.textContent);
      if (protectedCounts.get(surface) === count) continue;
      protectedCounts.set(surface, count);
      if (count > 0) devlog('restore.protected', { count });
    }
  };

  const finalize = (container: HTMLElement): void => {
    clearTimeout(quietTimers.get(container));
    quietTimers.delete(container);
    if (signal.aborted || !container.isConnected) return;
    settled.add(container);
    if (refreshMatcher()) schedule();
    const count = restoreBlock(container, container);
    if (count > 0) devlog('restore.applied', { count });
    // Leak check: stand-in text still visible after the final pass.
    devlog('restore.leak-check', {
      count: matcher.countOccurrences(collect(container).text),
    });
    reportProtected(container);
  };

  const markActive = (container: HTMLElement): void => {
    if (!adapter.isAssistantMessage(container)) return;
    settled.delete(container);
    clearTimeout(quietTimers.get(container));
    quietTimers.set(
      container,
      setTimeout(() => {
        finalize(container);
      }, quietMs),
    );
  };

  const hasPendingAncestor = (
    block: Element,
    container: HTMLElement,
    blocks: ReadonlySet<Element>,
  ): boolean => {
    for (
      let el = block.parentElement;
      el !== null && el !== container.parentElement;
      el = el.parentElement
    ) {
      if (blocks.has(el)) return true;
    }
    return false;
  };

  const run = (): void => {
    frame = null;
    if (signal.aborted) return;
    refreshMatcher();
    const blocks = new Set(pending);
    pending.clear();
    let count = 0;
    for (const block of blocks) {
      if (!block.isConnected) continue;
      const container = adapter.getMessageContainer(block);
      if (!container || hasPendingAncestor(block, container, blocks)) continue;
      if (!settled.has(container) && adapter.isReplyComplete?.(container)) {
        finalize(container);
        continue;
      }
      count += restoreBlock(block, container);
      // Settled messages have no quiet timer; their surfaces are reported
      // here (each only when its count changes).
      if (settled.has(container) && adapter.isAssistantMessage(container)) {
        reportProtected(container);
      }
    }
    if (count > 0) devlog('restore.applied', { count });
  };

  const schedule = (): void => {
    frame ??= requestAnimationFrame(run);
  };

  const enqueue = (node: Node): void => {
    if (!node.isConnected) return;
    const container = adapter.getMessageContainer(node);
    if (container) {
      pending.add(blockOf(node, container));
      markActive(container);
      schedule();
      return;
    }
    // A subtree holding whole messages (first render, switching chats).
    if (node instanceof Element) {
      const inside = adapter.getMessageContainers(node);
      for (const message of inside) {
        pending.add(message);
        markActive(message);
      }
      if (inside.length > 0) schedule();
    }
  };

  const observer = new MutationObserver((records) => {
    for (const record of records) {
      const { target } = record;
      if (record.type === 'characterData') {
        // Our own write: nothing to do.
        if (
          target instanceof Text &&
          writtenText.get(target) === target.nodeValue
        ) {
          continue;
        }
        enqueue(target);
      } else if (record.type === 'attributes') {
        if (
          target instanceof Element &&
          writtenHref.get(target) === target.getAttribute('href')
        ) {
          continue;
        }
        enqueue(target);
      } else {
        for (const added of Array.from(record.addedNodes)) enqueue(added);
      }
    }
  });

  observer.observe(root, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: ['href'],
  });

  // Catch up on messages already on screen. They are not streaming, so they
  // count as settled until they change.
  for (const container of adapter.getMessageContainers()) {
    pending.add(container);
    settled.add(container);
  }
  schedule();
  devlog('restore.started');

  signal.addEventListener(
    'abort',
    () => {
      observer.disconnect();
      if (frame !== null) cancelAnimationFrame(frame);
      for (const timer of quietTimers.values()) clearTimeout(timer);
      quietTimers.clear();
      pending.clear();
      devlog('restore.stopped');
    },
    { once: true },
  );
}
