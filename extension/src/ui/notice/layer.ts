/**
 * The in-page notice layer: one host element on the document root (never
 * inside the site's own DOM tree, which its framework manages), a closed
 * shadow root, plain DOM, and CSS written against the brand tokens.
 *
 * Notices are placed next to what they are about: under a card editor
 * (above it when there is no room, hidden while it is off screen), or above
 * the composer for page-level notices. They never take focus. A visually
 * hidden live region reads a notice out when the caller says so.
 *
 * Text goes in through textContent only; notices carry fixed words and
 * counts, never values.
 */
import type { NoticeContent } from '@/src/core/notice/text.ts';
import { tokenProperties } from '../tokens.ts';

export type NoticePlacement =
  | { readonly kind: 'card'; readonly anchor: HTMLElement }
  | { readonly kind: 'page' };

export interface NoticeLayerOptions {
  readonly doc?: Document;
  /** The user closed a notice (button or Esc). */
  readonly onDismiss: (key: string) => void;
  /** Where page-level notices sit above (the composer), if shown. */
  readonly pageAnchor: () => Element | null;
  /** 'open' only for tests; the page cannot reach a closed root. */
  readonly shadowMode?: ShadowRootMode;
}

export interface NoticeLayer {
  show(
    key: string,
    content: NoticeContent,
    placement: NoticePlacement,
    announce: boolean,
  ): void;
  hide(key: string): void;
  dispose(): void;
}

const GAP = 8;
const CARD_MAX_WIDTH = 560;
const PAGE_MAX_WIDTH = 720;
const EDGE = 16;
const SVG_NS = 'http://www.w3.org/2000/svg';

const FONT_STACK =
  "system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif";

/** Styles of the layer; colours only through the brand tokens. */
export function noticeCss(): string {
  return `
:host { all: initial; }
.layer {
  ${tokenProperties()}
  --notice-bg: var(--color-mist);
  --notice-fg: var(--color-graphite);
  --notice-mark: var(--color-mustard-ink);
  --notice-border: color-mix(in srgb, var(--color-spruce) 12%, transparent);
  --notice-focus: var(--color-spruce);
  font-family: ${FONT_STACK};
  font-size: 14px;
  line-height: 1.45;
}
.layer[data-theme='dark'] {
  --notice-bg: var(--color-night);
  --notice-fg: var(--color-mist);
  --notice-mark: var(--color-mustard);
  --notice-border: color-mix(in srgb, var(--color-mist) 16%, transparent);
  --notice-focus: var(--color-mist);
}
.notice {
  position: fixed;
  box-sizing: border-box;
  display: grid;
  grid-template-columns: auto 1fr auto;
  align-items: start;
  column-gap: 10px;
  padding: 12px 12px 12px 14px;
  border: 1px solid var(--notice-border);
  border-left: 4px solid var(--notice-mark);
  border-radius: 10px;
  background: var(--notice-bg);
  color: var(--notice-fg);
  box-shadow: 0 6px 24px color-mix(in srgb, var(--color-night) 18%, transparent);
  pointer-events: auto;
}
.notice[hidden] { display: none; }
.icon { width: 20px; height: 20px; color: var(--notice-mark); margin-top: 1px; }
.title { margin: 0; font-size: 14px; font-weight: 500; }
.body { margin: 2px 0 0; font-size: 13px; }
.dismiss {
  font: inherit;
  font-size: 13px;
  color: inherit;
  background: transparent;
  border: 1px solid var(--notice-border);
  border-radius: 6px;
  padding: 2px 8px;
  cursor: pointer;
}
.dismiss:focus-visible { outline: 2px solid var(--notice-focus); outline-offset: 2px; }
.sr-only {
  position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
  overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0;
}
@media (prefers-reduced-motion: no-preference) {
  .notice { animation: notice-in 150ms ease-out; }
  @keyframes notice-in { from { opacity: 0; transform: translateY(4px); } }
}
`;
}

/** A circle with an exclamation mark (outline, 1.5 px stroke). */
function icon(doc: Document): SVGSVGElement {
  const svg = doc.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.5');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', 'icon');
  const circle = doc.createElementNS(SVG_NS, 'circle');
  circle.setAttribute('cx', '12');
  circle.setAttribute('cy', '12');
  circle.setAttribute('r', '9');
  const line = doc.createElementNS(SVG_NS, 'path');
  line.setAttribute('d', 'M12 7.5v5.5M12 16.5h.01');
  svg.append(circle, line);
  return svg;
}

interface Shown {
  readonly el: HTMLElement;
  readonly title: HTMLElement;
  readonly body: HTMLElement;
  placement: NoticePlacement;
}

export function createNoticeLayer(options: NoticeLayerOptions): NoticeLayer {
  const doc = options.doc ?? document;
  const win = doc.defaultView;
  const shown = new Map<string, Shown>();
  let host: HTMLElement | null = null;
  let layer: HTMLElement | null = null;
  let announcer: HTMLElement | null = null;
  let frame: number | null = null;
  let themeObserver: MutationObserver | null = null;
  let resizeObserver: ResizeObserver | null = null;
  let serial = 0;

  const isDark = (): boolean => {
    const root = doc.documentElement.classList;
    if (root.contains('dark')) return true;
    if (root.contains('light')) return false;
    return win?.matchMedia('(prefers-color-scheme: dark)').matches ?? false;
  };

  const applyTheme = (): void => {
    layer?.setAttribute('data-theme', isDark() ? 'dark' : 'light');
  };

  const place = (notice: Shown, pageTop: number): number => {
    const { el, placement } = notice;
    const viewWidth = win?.innerWidth ?? 0;
    const viewHeight = win?.innerHeight ?? 0;
    if (placement.kind === 'card') {
      const rect = placement.anchor.getBoundingClientRect();
      const offScreen =
        !placement.anchor.isConnected ||
        rect.width === 0 ||
        rect.bottom <= 0 ||
        rect.top >= viewHeight;
      el.hidden = offScreen;
      if (offScreen) return pageTop;
      const width = Math.min(rect.width, CARD_MAX_WIDTH);
      el.style.width = `${width.toString()}px`;
      el.style.left = `${Math.max(EDGE, rect.left).toString()}px`;
      const height = el.offsetHeight;
      let top = rect.bottom + GAP;
      if (top + height > viewHeight - GAP) top = rect.top - GAP - height;
      if (top < GAP) top = Math.max(GAP, viewHeight - height - GAP);
      el.style.top = `${top.toString()}px`;
      return pageTop;
    }
    el.hidden = false;
    const anchor = options.pageAnchor()?.getBoundingClientRect() ?? null;
    const visible =
      anchor !== null &&
      anchor.width > 0 &&
      anchor.top > 0 &&
      anchor.top <= viewHeight;
    const width = Math.min(
      visible ? anchor.width : viewWidth - 2 * EDGE,
      visible ? PAGE_MAX_WIDTH : 480,
    );
    el.style.width = `${width.toString()}px`;
    const left = visible
      ? anchor.left + (anchor.width - width) / 2
      : (viewWidth - width) / 2;
    el.style.left = `${Math.max(EDGE, left).toString()}px`;
    const height = el.offsetHeight;
    const top = pageTop - GAP - height;
    el.style.top = `${Math.max(GAP, top).toString()}px`;
    return top;
  };

  const layout = (): void => {
    frame = null;
    const anchor = options.pageAnchor()?.getBoundingClientRect() ?? null;
    const viewHeight = win?.innerHeight ?? 0;
    // Page-level notices stack upwards from the composer (or the bottom).
    let pageTop =
      anchor !== null &&
      anchor.width > 0 &&
      anchor.top > 0 &&
      anchor.top <= viewHeight
        ? anchor.top
        : viewHeight - EDGE + GAP;
    for (const notice of shown.values()) pageTop = place(notice, pageTop);
  };

  const scheduleLayout = (): void => {
    if (frame !== null || win === null) return;
    frame = win.requestAnimationFrame(layout);
  };

  const listenerOptions = { capture: true, passive: true } as const;

  const ensureHost = (): HTMLElement => {
    if (layer !== null) return layer;
    host = doc.createElement('div');
    host.setAttribute('data-promptveil-notices', '');
    for (const [name, value] of [
      ['position', 'fixed'],
      ['inset', '0'],
      ['pointer-events', 'none'],
      ['z-index', '2147483647'],
      ['display', 'block'],
    ] as const) {
      host.style.setProperty(name, value, 'important');
    }
    const root = host.attachShadow({ mode: options.shadowMode ?? 'closed' });
    const style = doc.createElement('style');
    style.textContent = noticeCss();
    layer = doc.createElement('div');
    layer.className = 'layer';
    announcer = doc.createElement('div');
    announcer.className = 'sr-only';
    announcer.setAttribute('role', 'status');
    announcer.setAttribute('aria-live', 'polite');
    announcer.setAttribute('aria-atomic', 'true');
    layer.append(announcer);
    root.append(style, layer);
    doc.documentElement.append(host);
    applyTheme();
    themeObserver = new MutationObserver(applyTheme);
    themeObserver.observe(doc.documentElement, {
      attributes: true,
      attributeFilter: ['class'],
    });
    win?.addEventListener('scroll', scheduleLayout, listenerOptions);
    win?.addEventListener('resize', scheduleLayout, listenerOptions);
    if (typeof ResizeObserver === 'function') {
      resizeObserver = new ResizeObserver(scheduleLayout);
    }
    return layer;
  };

  const removeHost = (): void => {
    themeObserver?.disconnect();
    resizeObserver?.disconnect();
    win?.removeEventListener('scroll', scheduleLayout, listenerOptions);
    win?.removeEventListener('resize', scheduleLayout, listenerOptions);
    if (frame !== null) win?.cancelAnimationFrame(frame);
    frame = null;
    host?.remove();
    host = null;
    layer = null;
    announcer = null;
    themeObserver = null;
    resizeObserver = null;
  };

  const build = (key: string): Shown => {
    const parent = ensureHost();
    serial += 1;
    const titleId = `notice-title-${serial.toString()}`;
    const el = doc.createElement('section');
    el.className = 'notice';
    el.setAttribute('aria-labelledby', titleId);
    const text = doc.createElement('div');
    const title = doc.createElement('p');
    title.className = 'title';
    title.id = titleId;
    const body = doc.createElement('p');
    body.className = 'body';
    text.append(title, body);
    const dismiss = doc.createElement('button');
    dismiss.type = 'button';
    dismiss.className = 'dismiss';
    dismiss.textContent = 'Dismiss';
    dismiss.addEventListener('click', () => {
      options.onDismiss(key);
    });
    el.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') options.onDismiss(key);
    });
    el.append(icon(doc), text, dismiss);
    parent.append(el);
    return { el, title, body, placement: { kind: 'page' } };
  };

  return {
    show(key, content, placement, announce) {
      const notice = shown.get(key) ?? build(key);
      shown.set(key, notice);
      const previous = notice.placement;
      if (previous.kind === 'card') resizeObserver?.unobserve(previous.anchor);
      notice.placement = placement;
      if (placement.kind === 'card') resizeObserver?.observe(placement.anchor);
      notice.title.textContent = content.title;
      notice.body.textContent = content.body;
      if (announce && announcer !== null) {
        announcer.textContent = `${content.title}. ${content.body}`;
      }
      layout();
    },
    hide(key) {
      const notice = shown.get(key);
      if (notice === undefined) return;
      shown.delete(key);
      if (notice.placement.kind === 'card') {
        resizeObserver?.unobserve(notice.placement.anchor);
      }
      notice.el.remove();
      if (shown.size === 0) removeHost();
      else scheduleLayout();
    },
    dispose() {
      shown.clear();
      removeHost();
    },
  };
}
