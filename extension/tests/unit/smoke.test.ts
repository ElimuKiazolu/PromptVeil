import { describe, expect, it } from 'vitest';

describe('test setup', () => {
  it('runs in the node environment', () => {
    expect(typeof document).toBe('undefined');
  });
});
