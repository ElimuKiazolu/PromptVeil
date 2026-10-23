import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AdapterError } from '@/src/adapters/types.ts';
import {
  installInterceptor,
  type PromptTransform,
} from '@/src/content/interceptor.ts';
import { createSpikeMasker } from '@/src/core/spike-mask.ts';
import { detectEmailsOnly } from '../spike-detect.ts';
import { flush, pressKey, setUp, type Harness } from './harness.ts';

const upperCase: PromptTransform = (text) => text.toUpperCase();

describe('installInterceptor', () => {
  let h: Harness;
  let controller: AbortController;
  let contextValid: boolean;
  let netReady: boolean;
  let orphanedCalls: number;

  beforeEach(() => {
    h = setUp();
    controller = new AbortController();
    contextValid = true;
    netReady = true;
    orphanedCalls = 0;
  });

  afterEach(() => {
    controller.abort();
  });

  const install = (transform: PromptTransform = upperCase): void => {
    installInterceptor({
      adapter: h.adapter,
      transform,
      signal: controller.signal,
      isContextValid: () => contextValid,
      onOrphaned: () => {
        orphanedCalls += 1;
      },
      isNetReady: () => netReady,
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
    // The transform has started and is waiting.
    await flush();
    expect(h.triggered).toBe(0);
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
    h.composer.triggerSend = () => {
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
    const write = vi.spyOn(h.composer, 'writePrompt');
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
    h.composer.readPrompt = () => {
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
    const transform = vi.fn<PromptTransform>(
      (text) =>
        new Promise((resolve) => {
          release = () => {
            resolve(text.toUpperCase());
          };
        }),
    );
    install(transform);
    h.editor.textContent = 'hello';
    pressKey(h.editor, { key: 'Enter' });
    await flush();
    expect(transform).toHaveBeenCalledTimes(1);
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

  it('runs the transform after the event handler has returned', async () => {
    const transform = vi.fn(upperCase);
    install(transform);
    h.editor.textContent = 'hello';
    const event = pressKey(h.editor, { key: 'Enter' });
    expect(event.defaultPrevented).toBe(true);
    expect(transform).not.toHaveBeenCalled();
    await flush();
    expect(transform).toHaveBeenCalledTimes(1);
  });

  it('blocks a send when the extension context is gone', async () => {
    const transform = vi.fn(upperCase);
    install(transform);
    contextValid = false;
    h.editor.textContent = 'hello';
    const event = pressKey(h.editor, { key: 'Enter' });
    await flush();
    expect(event.defaultPrevented).toBe(true);
    expect(orphanedCalls).toBe(1);
    expect(transform).not.toHaveBeenCalled();
    expect(h.siteSends).toEqual([]);
  });

  it('does not send if the context is lost while processing', async () => {
    install((text) => {
      contextValid = false;
      return text.toUpperCase();
    });
    h.editor.textContent = 'hello';
    pressKey(h.editor, { key: 'Enter' });
    await flush();
    expect(orphanedCalls).toBe(1);
    expect(h.triggered).toBe(0);
    expect(h.siteSends).toEqual([]);
    expect(h.editor.textContent).toBe('hello');
  });

  it('leaves a sent prompt masked when the site keeps it in the editor', async () => {
    install(createSpikeMasker({ detect: detectEmailsOnly }).transform);
    h.editor.textContent = 'mail dana@example.com';
    pressKey(h.editor, { key: 'Enter' });
    await flush();
    // The site queued the message and left the text in place.
    expect(h.editor.textContent).toBe('mail standin.1@example.net');
    await flush();
    expect(h.editor.textContent).toBe('mail standin.1@example.net');

    const write = vi.spyOn(h.composer, 'writePrompt');
    pressKey(h.editor, { key: 'Enter' });
    await flush();
    expect(write).not.toHaveBeenCalled();
    expect(h.siteSends).toEqual([
      'mail standin.1@example.net',
      'mail standin.1@example.net',
    ]);
  });

  it('masks a send triggered by a synthetic page event', async () => {
    install(createSpikeMasker({ detect: detectEmailsOnly }).transform);
    h.editor.textContent = 'mail dana@example.com';
    h.button.dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true }),
    );
    await flush();
    expect(h.siteSends).toEqual(['mail standin.1@example.net']);
  });

  it('blocks every send while the request safety net is not confirmed', async () => {
    const transform = vi.fn(upperCase);
    install(transform);
    netReady = false;
    h.editor.textContent = 'hello';
    const enter = pressKey(h.editor, { key: 'Enter' });
    h.edit.editor.textContent = 'edited';
    const click = new MouseEvent('click', { bubbles: true, cancelable: true });
    h.edit.button.dispatchEvent(click);
    await flush();
    expect(enter.defaultPrevented).toBe(true);
    expect(click.defaultPrevented).toBe(true);
    expect(transform).not.toHaveBeenCalled();
    expect(h.siteSends).toEqual([]);
    expect(h.editSends).toEqual([]);
  });

  describe('edit box', () => {
    it('masks a send from the edit box and leaves the main composer alone', async () => {
      install(createSpikeMasker({ detect: detectEmailsOnly }).transform);
      h.editor.textContent = 'draft in main dana@example.com';
      h.edit.editor.textContent = 'Edited: write to ops@example.org';
      pressKey(h.edit.editor, { key: 'Enter' });
      await flush();
      expect(h.editSends).toEqual(['Edited: write to standin.1@example.net']);
      expect(h.siteSends).toEqual([]);
      expect(h.editor.textContent).toBe('draft in main dana@example.com');
    });

    it('sends from the box whose button was clicked', async () => {
      install(upperCase);
      h.editor.textContent = 'main';
      h.edit.editor.textContent = 'edit';
      h.edit.button.click();
      await flush();
      expect(h.editSends).toEqual(['EDIT']);
      expect(h.siteSends).toEqual([]);
      h.button.click();
      await flush();
      expect(h.siteSends).toEqual(['MAIN']);
      expect(h.editSends).toEqual(['EDIT']);
    });

    it('intercepts a submit of the edit form', async () => {
      install(upperCase);
      h.edit.editor.textContent = 'edit';
      const event = new Event('submit', { bubbles: true, cancelable: true });
      h.edit.form.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
      await flush();
      expect(h.editSends).toEqual(['EDIT']);
    });

    it('leaves known stand-ins in the edit box alone', async () => {
      const masker = createSpikeMasker({ detect: detectEmailsOnly });
      install(masker.transform);
      h.editor.textContent = 'first dana@example.com';
      pressKey(h.editor, { key: 'Enter' });
      await flush();

      // The edit box opens with the stand-in ChatGPT stored.
      h.edit.editor.textContent = 'first standin.1@example.net, more';
      const write = vi.spyOn(h.edit.composer, 'writePrompt');
      pressKey(h.edit.editor, { key: 'Enter' });
      await flush();
      expect(write).not.toHaveBeenCalled();
      expect(h.editSends).toEqual(['first standin.1@example.net, more']);
    });

    it('gives a value masked earlier the same stand-in in the edit box', async () => {
      install(createSpikeMasker({ detect: detectEmailsOnly }).transform);
      h.editor.textContent = 'first dana@example.com';
      pressKey(h.editor, { key: 'Enter' });
      await flush();

      h.edit.editor.textContent = 'again dana@example.com and new@example.org';
      pressKey(h.edit.editor, { key: 'Enter' });
      await flush();
      expect(h.editSends).toEqual([
        'again standin.1@example.net and standin.2@example.net',
      ]);
    });

    it('leaves stand-ins from an earlier page load alone', async () => {
      install(createSpikeMasker({ detect: detectEmailsOnly }).transform);
      h.edit.editor.textContent =
        'old standin.7@example.net and dana@example.com';
      pressKey(h.edit.editor, { key: 'Enter' });
      await flush();
      expect(h.editSends).toEqual([
        'old standin.7@example.net and standin.1@example.net',
      ]);
    });
  });
});
