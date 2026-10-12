import { afterEach, describe, expect, it } from 'vitest';
import { installInterceptor } from '@/src/content/interceptor.ts';
import { installSendGuard } from '@/src/content/send-guard.ts';
import { flush, pressKey, setUp } from './harness.ts';

describe('installSendGuard', () => {
  const controllers: AbortController[] = [];

  afterEach(() => {
    for (const controller of controllers) controller.abort();
    // Any guard still active stands down when an instance announces itself.
    window.dispatchEvent(new Event('promptveil:interceptor-ready'));
  });

  const startInterceptor = (h: ReturnType<typeof setUp>): AbortController => {
    const controller = new AbortController();
    controllers.push(controller);
    installInterceptor({
      adapter: h.adapter,
      transform: (text) => text.toUpperCase(),
      signal: controller.signal,
    });
    return controller;
  };

  it('blocks every send path and leaves other keys alone', () => {
    const h = setUp();
    installSendGuard(h.adapter);
    h.editor.textContent = 'hello';

    const enter = pressKey(h.editor, { key: 'Enter' });
    const click = new MouseEvent('click', { bubbles: true, cancelable: true });
    h.button.dispatchEvent(click);
    const submit = new Event('submit', { bubbles: true, cancelable: true });
    h.form.dispatchEvent(submit);
    const newline = pressKey(h.editor, { key: 'Enter', shiftKey: true });
    const letter = pressKey(h.editor, { key: 'a' });

    expect(enter.defaultPrevented).toBe(true);
    expect(click.defaultPrevented).toBe(true);
    expect(submit.defaultPrevented).toBe(true);
    expect(newline.defaultPrevented).toBe(false);
    expect(letter.defaultPrevented).toBe(false);
    expect(h.siteSends).toEqual([]);
  });

  it('takes over from an invalidated interceptor', async () => {
    const h = setUp();
    const old = startInterceptor(h);
    old.abort();
    installSendGuard(h.adapter);
    h.editor.textContent = 'hello';
    pressKey(h.editor, { key: 'Enter' });
    await flush();
    expect(h.siteSends).toEqual([]);
  });

  it('stands down when a newer interceptor is already running', async () => {
    const h = setUp();
    const old = startInterceptor(h);
    startInterceptor(h);
    old.abort();
    installSendGuard(h.adapter);
    h.editor.textContent = 'hello';
    pressKey(h.editor, { key: 'Enter' });
    await flush();
    expect(h.siteSends).toEqual(['HELLO']);
  });

  it('stands down when a newer interceptor starts later', async () => {
    const h = setUp();
    installSendGuard(h.adapter);
    startInterceptor(h);
    h.editor.textContent = 'hello';
    pressKey(h.editor, { key: 'Enter' });
    await flush();
    expect(h.siteSends).toEqual(['HELLO']);
  });
});
