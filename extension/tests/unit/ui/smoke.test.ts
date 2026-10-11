import { describe, expect, it } from 'vitest';

describe('ui test setup', () => {
  it('runs in the jsdom environment', () => {
    expect(typeof document).toBe('object');
  });
});
