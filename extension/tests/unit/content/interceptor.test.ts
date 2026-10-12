import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AdapterError } from '@/src/adapters/types.ts';
import {
  installInterceptor,
  type PromptTransform,
} from '@/src/content/interceptor.ts';
import { flush, pressKey, setUp, type Harness } from './harness.ts';

const upperCase: PromptTransform = (text) => text.toUpperCase();

describe('installInterceptor', () => {
  let h: Harness;
  let controller: AbortController;

  beforeEach(() => {
    h = setUp();
    controller = new AbortController();
  });

  afterEach(() => {
    controller.abort();
  });

  const install = (transform: PromptTransform = upperCase): void => {
    installInterceptor({
      adapter: h.adapter,
      transform,
      signal: controller.signal,
    });
  };

  it('sends once on Enter, with the transformed text only', async () => {
    install();
    h.editor.textContent = 'hello';
    const event = pressKey(h.editor, { key: 'Enter' });
    expect(event.defaultPrevented).toBe(true);
    await flush();
    expect(h.triggered).toBe(1);
    expect(h.siteSends).toEqual(['HELLO']);
  });

  it('treats Ctrl+Enter and Cmd+Enter as sends', async () => {
    install();
    h.editor.textContent = 'a';
    pressKey(h.editor, { key: 'Enter', ctrlKey: true });
    await flush();
    h.editor.textContent = 'b';
    pressKey(h.editor, { key: 'Enter', metaKey: true });
    await flush();
    expect(h.siteSends).toEqual(['A', 'B']);
  });

  it('lets Shift+Enter through untouched', async () => {
    install();
    h.editor.textContent = 'hello';
    const event = pressKey(h.editor, { key: 'Enter', shiftKey: true });
    await flush();
    expect(event.defaultPrevented).toBe(false);
    expect(h.triggered).toBe(0);
    expect(h.siteSends).toEqual([]);
  });

  it('ignores Enter while an IME composition is active', async () => {
    install();
    h.editor.textContent = 'hello';
    pressKey(h.editor, { key: 'Enter', isComposing: true });
    await flush();
    expect(h.triggered).toBe(0);
  });

  it('ignores Enter outside the editor', async () => {
    install();
    h.editor.textContent = 'hello';
    const other = document.createElement('input');
    document.body.append(other);
    const event = pressKey(other, { key: 'Enter' });
    await flush();
    expect(event.defaultPrevented).toBe(false);
    expect(h.triggered).toBe(0);
  });

  it('blocks a second send while the first is processing', async () => {
    let release: () => void = () => undefined;
    const slow: PromptTransform = (text) =>
      new Promise((resolve) => {
        release = () => {
          resolve(text.toUpperCase());
        };
      });
    install(slow);
    h.editor.textContent = 'hello';
    pressKey(h.editor, { key: 'Enter' });
    const second = pressKey(h.editor, { key: 'Enter' });
    h.button.click();
    expect(second.defaultPrevented).toBe(true);
    expect(h.siteSends).toEqual([]);
    release();
    await flush();
    expect(h.triggered).toBe(1);
    expect(h.siteSends).toEqual(['HELLO']);
  });

  it('accepts a new send after the previous one finished', async () => {
    install();
    h.editor.textContent = 'one';
    pressKey(h.editor, { key: 'Enter' });
    await flush();
    h.editor.textContent = 'two';
    pressKey(h.editor, { key: 'Enter' });
    await flush();
    expect(h.siteSends).toEqual(['ONE', 'TWO']);
  });

  it('does not send when writePrompt rejects, and restores the original', async () => {
    install();
    h.failingWrites = 1;
    h.editor.textContent = 'hello';
    pressKey(h.editor, { key: 'Enter' });
    await flush();
    expect(h.triggered).toBe(0);
    expect(h.siteSends).toEqual([]);
    expect(h.editor.textContent).toBe('hello');
  });

  it('still does not send when restoring the original also fails', async () => {
    install();
    h.failingWrites = 2;
    h.editor.textContent = 'hello';
    pressKey(h.editor, { key: 'Enter' });
    await flush();
    expect(h.triggered).toBe(0);
    expect(h.siteSends).toEqual([]);
  });

  it('does not send when the transform throws', async () => {
    install(() => {
      throw new Error('boom');
    });
    h.editor.textContent = 'hello';
    pressKey(h.editor, { key: 'Enter' });
    await flush();
    expect(h.triggered).toBe(0);
    expect(h.editor.textContent).toBe('hello');
  });

  it('does not send when triggerSend throws, and restores the original', async () => {
    install();
    h.adapter.triggerSend = () => {
      throw new AdapterError('send-button-disabled');
    };
    h.editor.textContent = 'hello';
    pressKey(h.editor, { key: 'Enter' });
    await flush();
    expect(h.siteSends).toEqual([]);
    expect(h.editor.textContent).toBe('hello');
  });

  it('does not send when the user edits the prompt during processing', async () => {
    install(async (text) => {
      h.editor.textContent = 'changed meanwhile';
      await Promise.resolve();
      return text.toUpperCase();
    });
    h.editor.textContent = 'hello';
    pressKey(h.editor, { key: 'Enter' });
    await flush();
    expect(h.triggered).toBe(0);
    expect(h.editor.textContent).toBe('changed meanwhile');
  });

  it('sends without rewriting when the transform changes nothing', async () => {
    install((text) => text);
    const write = vi.spyOn(h.adapter, 'writePrompt');
    h.editor.textContent = 'nothing to mask';
    pressKey(h.editor, { key: 'Enter' });
    await flush();
    expect(write).not.toHaveBeenCalled();
    expect(h.siteSends).toEqual(['nothing to mask']);
  });

  it('lets an empty prompt through to the site', () => {
    const transform = vi.fn(upperCase);
    install(transform);
    h.editor.textContent = '   ';
    const event = pressKey(h.editor, { key: 'Enter' });
    expect(event.defaultPrevented).toBe(false);
    expect(transform).not.toHaveBeenCalled();
  });

  it('does not intercept its own send (guard flag)', async () => {
    const transform = vi.fn(upperCase);
    install(transform);
    h.editor.textContent = 'hello';
    pressKey(h.editor, { key: 'Enter' });
    await flush();
    await flush();
    expect(transform).toHaveBeenCalledTimes(1);
    expect(h.triggered).toBe(1);
    expect(h.siteSends).toEqual(['HELLO']);
  });

  it('intercepts clicks on the send button and its children', async () => {
    install();
    h.editor.textContent = 'click';
    h.button
      .querySelector('span')
      ?.dispatchEvent(
        new MouseEvent('click', { bubbles: true, cancelable: true }),
      );
    await flush();
    expect(h.siteSends).toEqual(['CLICK']);
  });

  it('intercepts a form submit that contains the editor', async () => {
    install();
    h.editor.textContent = 'submitted';
    const event = new Event('submit', { bubbles: true, cancelable: true });
    h.form.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    await flush();
    expect(h.siteSends).toEqual(['SUBMITTED']);
  });

  it('blocks the send when the prompt cannot be read', async () => {
    install();
    h.adapter.readPrompt = () => {
      throw new AdapterError('editor-missing');
    };
    const event = new MouseEvent('click', { bubbles: true, cancelable: true });
    h.button.dispatchEvent(event);
    await flush();
    expect(event.defaultPrevented).toBe(true);
    expect(h.siteSends).toEqual([]);
  });

  it('does not send if the context is invalidated mid-send', async () => {
    let release: () => void = () => undefined;
    install(
      (text) =>
        new Promise((resolve) => {
          release = () => {
            resolve(text.toUpperCase());
          };
        }),
    );
    h.editor.textContent = 'hello';
    pressKey(h.editor, { key: 'Enter' });
    controller.abort();
    release();
    await flush();
    expect(h.siteSends).toEqual([]);
    expect(h.editor.textContent).toBe('hello');
  });

  it('removes its listeners when the signal aborts', async () => {
    install();
    controller.abort();
    h.editor.textContent = 'hello';
    const event = pressKey(h.editor, { key: 'Enter' });
    await flush();
    expect(event.defaultPrevented).toBe(false);
    expect(h.triggered).toBe(0);
    expect(h.siteSends).toEqual(['hello']);
  });
});
