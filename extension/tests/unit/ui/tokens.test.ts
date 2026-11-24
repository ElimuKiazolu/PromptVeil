import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { COLOR_TOKENS, contrast } from '@/src/ui/tokens.ts';

// Tests run from the extension folder (jsdom gives no file: module URL).
const themeCss = readFileSync('src/ui/theme.css', 'utf8');

describe('colour tokens', () => {
  it('match theme.css exactly', () => {
    const inTheme = Object.fromEntries(
      [...themeCss.matchAll(/--color-([\w-]+):\s*(#[0-9a-f]{6});/gi)].map(
        (m): [string, string] => [m[1] ?? '', (m[2] ?? '').toLowerCase()],
      ),
    );
    expect(inTheme).toEqual(COLOR_TOKENS);
  });

  it('give the notice AA contrast in both themes', () => {
    const t = COLOR_TOKENS;
    // Text on its background.
    expect(contrast(t.graphite, t.mist)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(t.mist, t.night)).toBeGreaterThanOrEqual(4.5);
    // The mark: mustard-ink on Mist (light), Mustard on Night spruce (dark).
    expect(contrast(t['mustard-ink'], t.mist)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(t.mustard, t.night)).toBeGreaterThanOrEqual(4.5);
    // Mustard itself is not enough on Mist: why mustard-ink exists.
    expect(contrast(t.mustard, t.mist)).toBeLessThan(3);
  });

  it('keeps mustard-ink at the hue of mustard', () => {
    const hue = (hex: string): number => {
      const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
      const max = Math.max(r ?? 0, g ?? 0, b ?? 0);
      const min = Math.min(r ?? 0, g ?? 0, b ?? 0);
      // Both are red-dominant yellows: hue = 60 * (g - b) / (max - min).
      return (60 * ((g ?? 0) - (b ?? 0))) / (max - min);
    };
    expect(
      Math.abs(hue(COLOR_TOKENS['mustard-ink']) - hue(COLOR_TOKENS.mustard)),
    ).toBeLessThan(1);
  });
});
