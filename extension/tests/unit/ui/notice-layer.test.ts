import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createNoticeLayer,
  noticeCss,
  type NoticeLayer,
} from '@/src/ui/notice/layer.ts';

const CONTENT = {
  title: "This edit wasn't saved",
  body: 'It has 1 email. PromptVeil stopped ChatGPT from storing it.',
};

const layers: NoticeLayer[] = [];

function setUp() {
  const onDismiss = vi.fn();
  const composer = document.createElement('form');
  document.body.append(composer);
  const layer = createNoticeLayer({
    onDismiss,
    pageAnchor: () => composer,
    shadowMode: 'open',
  });
  layers.push(layer);
  const host = () =>
    document.documentElement.querySelector<HTMLElement>(
      '[data-promptveil-notices]',
    );
  const root = () => {
    const shadow = host()?.shadowRoot;
    if (!shadow) throw new Error('no layer');
    return shadow;
  };
  return { layer, onDismiss, host, root };
}

// jsdom has no matchMedia: the system theme is light here.
beforeEach(() => {
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({ matches: false, media: query })),
  );
});

afterEach(() => {
  for (const layer of layers.splice(0)) layer.dispose();
  document.body.replaceChildren();
  document.documentElement.className = '';
  vi.unstubAllGlobals();
});

describe('notice layer', () => {
  it('adds one host on the document root only while a notice shows', () => {
    const { layer, host } = setUp();
    expect(host()).toBeNull();
    layer.show('a', CONTENT, { kind: 'page' }, true, 'warning');
    layer.show('b', CONTENT, { kind: 'page' }, false, 'warning');
    expect(host()?.parentElement).toBe(document.documentElement);
    expect(
      document.documentElement.querySelectorAll('[data-promptveil-notices]'),
    ).toHaveLength(1);
    layer.hide('a');
    expect(host()).not.toBeNull();
    layer.hide('b');
    expect(host()).toBeNull();
  });

  it('shows the title and body as text, labelled, with a dismiss button', () => {
    const { layer, root } = setUp();
    layer.show('a', CONTENT, { kind: 'page' }, false, 'warning');
    const notice = root().querySelector('section');
    expect(notice?.querySelector('.title')?.textContent).toBe(CONTENT.title);
    expect(notice?.querySelector('.body')?.textContent).toBe(CONTENT.body);
    const labelledBy = notice?.getAttribute('aria-labelledby') ?? '';
    expect(root().getElementById(labelledBy)?.textContent).toBe(CONTENT.title);
    expect(notice?.querySelector('button')?.textContent).toBe('Dismiss');
  });

  it('updates a notice in place instead of adding another', () => {
    const { layer, root } = setUp();
    layer.show('a', CONTENT, { kind: 'page' }, false, 'warning');
    layer.show(
      'a',
      { ...CONTENT, body: 'It has 2 emails.' },
      { kind: 'page' },
      false,
      'warning',
    );
    const notices = root().querySelectorAll('section');
    expect(notices).toHaveLength(1);
    expect(notices[0]?.querySelector('.body')?.textContent).toBe(
      'It has 2 emails.',
    );
  });

  it('reads a notice out through the live region only when asked', () => {
    const { layer, root } = setUp();
    layer.show('a', CONTENT, { kind: 'page' }, false, 'warning');
    const status = root().querySelector('[role="status"]');
    expect(status?.getAttribute('aria-live')).toBe('polite');
    expect(status?.textContent).toBe('');
    layer.show('a', CONTENT, { kind: 'page' }, true, 'warning');
    expect(status?.textContent).toBe(`${CONTENT.title}. ${CONTENT.body}`);
  });

  it('never moves focus, and dismisses by button or Escape', () => {
    const { layer, root, onDismiss } = setUp();
    const editor = document.createElement('textarea');
    document.body.append(editor);
    editor.focus();
    layer.show('a', CONTENT, { kind: 'page' }, true, 'warning');
    expect(document.activeElement).toBe(editor);
    root().querySelector('button')?.click();
    expect(onDismiss).toHaveBeenCalledWith('a');
    root()
      .querySelector('section')
      ?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(onDismiss).toHaveBeenCalledTimes(2);
  });

  it("follows the site's dark class", async () => {
    const { layer, root } = setUp();
    layer.show('a', CONTENT, { kind: 'page' }, false, 'warning');
    const themed = root().querySelector('.layer');
    expect(themed?.getAttribute('data-theme')).toBe('light');
    document.documentElement.classList.add('dark');
    await Promise.resolve();
    expect(themed?.getAttribute('data-theme')).toBe('dark');
  });

  it('hides a card notice while its card is not on screen', () => {
    const { layer, root } = setUp();
    const card = document.createElement('div');
    layer.show(
      'card:1',
      CONTENT,
      { kind: 'card', anchor: card },
      false,
      'warning',
    );
    // Not connected (and jsdom gives no layout): treated as off screen.
    expect(root().querySelector('section')?.hidden).toBe(true);
  });

  it('removes everything on dispose', () => {
    const { layer, host } = setUp();
    layer.show('a', CONTENT, { kind: 'page' }, false, 'warning');
    layer.dispose();
    expect(host()).toBeNull();
  });
});

describe('notice styles', () => {
  it('use the brand tokens for every colour', () => {
    const css = noticeCss();
    // No literal colours outside the token definitions.
    const rules = css.replace(/--color-[\w-]+: #[0-9a-f]{6};/g, '');
    expect(rules).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i);
    expect(css).toContain('--color-mustard-ink: #896610;');
  });
});

describe('notice states', () => {
  it('marks the tone on the notice: warning or error', () => {
    const { layer, root } = setUp();
    layer.show('a', CONTENT, { kind: 'page' }, false, 'warning');
    expect(root().querySelector('section')?.getAttribute('data-tone')).toBe(
      'warning',
    );
    layer.show('a', CONTENT, { kind: 'page' }, false, 'error');
    expect(root().querySelector('section')?.getAttribute('data-tone')).toBe(
      'error',
    );
  });

  it('draws the state from the bottom edge, with no side bar', () => {
    const css = noticeCss();
    expect(css).not.toContain('border-left');
    // The glow covers the bottom quarter and fades out at its top.
    expect(css).toMatch(
      /linear-gradient\(to top, color-mix\(in srgb, var\(--tone\) \d+%, transparent\), transparent 25%\)/,
    );
    // Error notices use Brick (light) and the lighter Brick (dark).
    expect(css).toContain('--notice-error: var(--color-brick);');
    expect(css).toContain('--notice-error: var(--color-brick-light);');
    // No animation of the glow: only the entrance fade, and only without
    // reduced motion.
    expect(css.match(/animation:/g)).toHaveLength(1);
    expect(css).toMatch(
      /prefers-reduced-motion: no-preference\) \{\s*\.notice \{ animation/,
    );
  });
});
