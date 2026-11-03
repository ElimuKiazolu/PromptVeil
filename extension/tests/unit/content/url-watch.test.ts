import { afterEach, describe, expect, it, vi } from 'vitest';
import { watchUrlChanges } from '@/src/content/url-watch.ts';

afterEach(() => {
  Reflect.deleteProperty(window, 'navigation');
  vi.useRealTimers();
});

describe('watchUrlChanges', () => {
  it('follows the Navigation API where the browser has it', async () => {
    const navigation = new EventTarget();
    Object.defineProperty(window, 'navigation', {
      value: navigation,
      configurable: true,
    });
    const onChange = vi.fn();
    const controller = new AbortController();
    watchUrlChanges({ onChange, signal: controller.signal });

    navigation.dispatchEvent(new Event('currententrychange'));
    expect(onChange).toHaveBeenCalledTimes(1);
    // \`navigate\` fires before the URL changes: checked in the next task.
    navigation.dispatchEvent(new Event('navigate'));
    expect(onChange).toHaveBeenCalledTimes(1);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(onChange).toHaveBeenCalledTimes(2);

    controller.abort();
    navigation.dispatchEvent(new Event('currententrychange'));
    navigation.dispatchEvent(new Event('navigate'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it('polls every 500 ms without the Navigation API', () => {
    vi.useFakeTimers();
    const onChange = vi.fn();
    const controller = new AbortController();
    watchUrlChanges({ onChange, signal: controller.signal });
    vi.advanceTimersByTime(1_499);
    expect(onChange).toHaveBeenCalledTimes(2);
    controller.abort();
    vi.advanceTimersByTime(5_000);
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it('does nothing once aborted', () => {
    vi.useFakeTimers();
    const onChange = vi.fn();
    const controller = new AbortController();
    controller.abort();
    watchUrlChanges({ onChange, signal: controller.signal });
    vi.advanceTimersByTime(5_000);
    expect(onChange).not.toHaveBeenCalled();
  });
});
