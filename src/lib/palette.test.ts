import { describe, expect, it } from 'vitest';
import { buildPalette, linearToSrgb, nearestPaletteIndex, srgbToLinear } from './palette';

describe('perceptual palette generation', () => {
  it('round-trips sRGB values through linear light', () => {
    expect(linearToSrgb(srgbToLinear(0))).toBe(0);
    expect(linearToSrgb(srgbToLinear(1))).toBe(1);
    expect(linearToSrgb(srgbToLinear(2))).toBe(2);
    expect(linearToSrgb(srgbToLinear(128))).toBe(128);
    expect(linearToSrgb(srgbToLinear(240))).toBe(240);
    expect(linearToSrgb(srgbToLinear(255))).toBe(255);
  });

  it('preserves separated dominant colors with a small palette', () => {
    const colors = [
      ...Array.from({ length: 80 }, () => ({ r: 240, g: 30, b: 35 })),
      ...Array.from({ length: 50 }, () => ({ r: 30, g: 210, b: 70 })),
      ...Array.from({ length: 30 }, () => ({ r: 35, g: 60, b: 240 })),
    ];
    const palette = buildPalette(colors, 3);
    const red = palette[nearestPaletteIndex({ r: 240, g: 30, b: 35 }, palette)];
    const green = palette[nearestPaletteIndex({ r: 30, g: 210, b: 70 }, palette)];
    const blue = palette[nearestPaletteIndex({ r: 35, g: 60, b: 240 }, palette)];
    expect(red.r).toBeGreaterThan(red.g * 2);
    expect(green.g).toBeGreaterThan(green.r * 2);
    expect(blue.b).toBeGreaterThan(blue.r * 2);
  });
});
