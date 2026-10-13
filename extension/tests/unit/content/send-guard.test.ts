import { describe, expect, it } from 'vitest';
import { installSendGuard } from '@/src/content/send-guard.ts';
import { pressKey, setUp } from './harness.ts';

const click = (el: HTMLElement): MouseEvent => {
  const event = new MouseEvent('click', { bubbles: true, cancelable: true });
  el.dispatchEvent(event);
  return event;
};

const submit = (form: HTMLFormElement): Event => {
  const event = new Event('submit', { bubbles: true, cancelable: true });
  form.dispatchEvent(event);
  return event;
};

describe('installSendGuard', () => {
  it('blocks every send path and leaves other keys alone', () => {
    const h = setUp();
    installSendGuard(h.adapter);
    h.editor.textContent = 'hello';

    expect(pressKey(h.editor, { key: 'Enter' }).defaultPrevented).toBe(true);
    expect(click(h.button).defaultPrevented).toBe(true);
    expect(submit(h.form).defaultPrevented).toBe(true);
    expect(
      pressKey(h.editor, { key: 'Enter', shiftKey: true }).defaultPrevented,
    ).toBe(false);
    expect(pressKey(h.editor, { key: 'a' }).defaultPrevented).toBe(false);
    expect(h.siteSends).toEqual([]);
  });

  it('cannot be stood down by events a page script dispatches', () => {
    const h = setUp();
    installSendGuard(h.adapter);
    h.editor.textContent = 'dana@example.com';

    for (const type of [
      'promptveil:instance-started',
      'promptveil:interceptor-ready',
      'promptveil:interceptor-ping',
      'promptveil:instance-alive',
    ]) {
      window.dispatchEvent(new Event(type));
      document.dispatchEvent(new CustomEvent(type, { detail: { ok: true } }));
    }

    expect(pressKey(h.editor, { key: 'Enter' }).defaultPrevented).toBe(true);
    expect(click(h.button).defaultPrevented).toBe(true);
    expect(submit(h.form).defaultPrevented).toBe(true);
    expect(h.siteSends).toEqual([]);
  });

  it('blocks synthetic sends as well as user ones', () => {
    const h = setUp();
    installSendGuard(h.adapter);
    h.editor.textContent = 'dana@example.com';
    // Synthetic events from page scripts are untrusted; they are still sends.
    h.button.click();
    expect(h.siteSends).toEqual([]);
  });
});
