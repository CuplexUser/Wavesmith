// Display colors for the three light channels. The standard palette shows the physical red,
// green, and blue; the color-blind palette maps them to vermillion, yellow, and blue, which stay
// distinct under the common red–green deficiencies (after Okabe and Ito). Additive mixing is
// kept, so a white beam still reads as white-ish and a split beam as separate colors.

import type { Palette } from '../progress/store';
import type { Color } from '../types';

type Rgb = [number, number, number];

interface PaletteDef {
  /** Shader mixing weights per channel (linear, before tone mapping). */
  mix: Record<Color, Rgb>;
  /** Display color of each channel for glyphs and HUD accents. */
  hex: Record<Color, string>;
}

const PALETTES: Record<Palette, PaletteDef> = {
  standard: {
    mix: { red: [1.0, 0.13, 0.08], green: [0.1, 1.0, 0.24], blue: [0.14, 0.3, 1.0] },
    hex: { red: '#ff5a4f', green: '#4dff7a', blue: '#5b8cff' },
  },
  colorblind: {
    mix: { red: [1.0, 0.36, 0.0], green: [0.62, 0.74, 0.12], blue: [0.0, 0.42, 1.0] },
    hex: { red: '#ff7a1a', green: '#f0e442', blue: '#3d8bff' },
  },
};

let active: Palette = 'standard';

export function setPalette(p: Palette): void {
  active = p;
}

export function paletteMix(): Record<Color, Rgb> {
  return PALETTES[active].mix;
}

export function lightHex(c: Color): string {
  return PALETTES[active].hex[c];
}

const parse = (hex: string): Rgb => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as Rgb;

/** Display color for a set of light colors (white when all three or unspecified). */
export function colorsHex(colors: Color[] | undefined): string {
  if (!colors || colors.length === 3) return '#f4f7ff';
  if (colors.length === 1) return lightHex(colors[0]!);
  // Additive mix of two channels, brightened so the larger component reaches full scale.
  const sum = colors.map((c) => parse(lightHex(c))).reduce((a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]]);
  const k = 255 / Math.max(...sum);
  return `#${sum.map((v) => Math.round(v * k).toString(16).padStart(2, '0')).join('')}`;
}
