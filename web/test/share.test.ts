import { describe, expect, it } from 'vitest';
import { decodeLayout, encodeLayout, shareUrl } from '../src/share';
import type { Item } from '../src/types';

const layout: Item[] = [
  { kind: 'prism', pos: [327.123456, 68], size: [110, 55], angle: -2.35619449, material: 'flint' },
  { kind: 'reflector', a: [10, 20], b: [40.5, 60], bulge: 4 },
];

describe('shareable layouts', () => {
  it('round-trips a layout, rounded to hundredths', () => {
    const back = decodeLayout(encodeLayout(layout));
    expect(back).toEqual([
      { kind: 'prism', pos: [327.12, 68], size: [110, 55], angle: -2.36, material: 'flint' },
      { kind: 'reflector', a: [10, 20], b: [40.5, 60], bulge: 4 },
    ]);
  });

  it('uses URL-safe characters only', () => {
    expect(encodeLayout(layout)).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('rejects malformed codes', () => {
    expect(decodeLayout('not base64!')).toBeNull();
    expect(decodeLayout(encodeLayout([{ kind: 'laser', pos: [1, 2] } as unknown as Item]))).toBeNull();
    expect(decodeLayout(encodeLayout([{ kind: 'wall', a: [1, 2] } as unknown as Item]))).toBeNull();
  });

  it('builds a link into the play route', () => {
    const url = shareUrl('5-4', layout, 'https://example.com/wavesmith/#/levels');
    expect(url.startsWith('https://example.com/wavesmith/#/play/5-4?s=')).toBe(true);
  });
});
