/**
 * The brand colour tokens of theme.css as values, for UI that cannot use the
 * Tailwind build: the in-page notice's hand-written CSS inside its Shadow
 * DOM. A test keeps this list equal to theme.css.
 */
export const COLOR_TOKENS = {
  spruce: '#17322b',
  copper: '#b5653a',
  'copper-light': '#d08155',
  'copper-tint': '#f3e3d8',
  'copper-ink': '#7a3e1f',
  sage: '#8fa89a',
  mist: '#eef1ee',
  graphite: '#262a28',
  night: '#0f1c18',
  mustard: '#b98a16',
  'mustard-ink': '#896610',
  brick: '#a3262a',
} as const;

export type ColorToken = keyof typeof COLOR_TOKENS;

/** CSS custom properties for the tokens (`--color-<name>: <value>;`). */
export function tokenProperties(): string {
  return Object.entries(COLOR_TOKENS)
    .map(([name, value]) => `--color-${name}: ${value};`)
    .join(' ');
}

/** WCAG 2.x relative luminance of a #rrggbb colour. */
export function luminance(hex: string): number {
  const channel = (offset: number): number => {
    const c = parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

/** WCAG contrast ratio of two #rrggbb colours. */
export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return ((hi ?? 0) + 0.05) / ((lo ?? 0) + 0.05);
}
