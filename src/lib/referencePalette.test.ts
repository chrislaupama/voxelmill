import { describe, expect, it } from 'vitest';
import type { RGB } from '../types';
import { perceptualColorDistance, rgbToOklch } from './palette';
import {
  extractReferencePalette,
  REFERENCE_PALETTE_MAX_COLORS,
  REFERENCE_PALETTE_MIN_COLORS,
} from './referencePalette';

const rgba = (colors: Array<RGB & { a?: number }>) => {
  const pixels = new Uint8ClampedArray(colors.length * 4);
  colors.forEach((color, index) => {
    pixels.set([color.r, color.g, color.b, color.a ?? 255], index * 4);
  });
  return pixels;
};

const repeat = (color: RGB & { a?: number }, count: number) => Array.from({ length: count }, () => color);

const hasNear = (palette: RGB[], expected: RGB, maximumDistance = 8) =>
  palette.some((color) => perceptualColorDistance(color, expected) <= maximumDistance);

describe('reference image palette extraction', () => {
  it('represents dominant source colors with population-aware swatches', () => {
    const colors = [
      ...repeat({ r: 218, g: 42, b: 38 }, 60),
      ...repeat({ r: 30, g: 94, b: 220 }, 30),
      ...repeat({ r: 240, g: 190, b: 42 }, 10),
    ];
    const result = extractReferencePalette(rgba(colors), colors.length, 1, { colorCount: 4 });

    expect(hasNear(result.palette, { r: 218, g: 42, b: 38 }, 4)).toBe(true);
    expect(hasNear(result.palette, { r: 30, g: 94, b: 220 }, 4)).toBe(true);
    expect(hasNear(result.palette, { r: 240, g: 190, b: 42 }, 4)).toBe(true);
    expect(result.diagnostics.swatches.reduce((sum, swatch) => sum + swatch.coverage, 0)).toBeCloseTo(1, 8);
  });

  it('protects small, meaningful chromatic accents from a dominant neutral field', () => {
    const gray = { r: 112, g: 116, b: 118 };
    const teal = { r: 16, g: 210, b: 184 };
    const orange = { r: 245, g: 102, b: 22 };
    const colors = [...repeat(gray, 970), ...repeat(teal, 20), ...repeat(orange, 10)];
    const result = extractReferencePalette(rgba(colors), 100, 10, { colorCount: 4 });

    expect(hasNear(result.palette, gray, 4)).toBe(true);
    expect(hasNear(result.palette, teal, 6)).toBe(true);
    expect(hasNear(result.palette, orange, 6)).toBe(true);
    expect(result.diagnostics.accentFamiliesDetected).toBe(2);
    expect(result.diagnostics.accentFamiliesPreserved).toBe(2);
  });

  it('ignores transparent pixels and weights partially transparent pixels by visibility', () => {
    const transparentMagenta = repeat({ r: 255, g: 0, b: 255, a: 0 }, 100);
    const visibleGreen = repeat({ r: 30, g: 190, b: 70 }, 12);
    const faintBlue = repeat({ r: 20, g: 40, b: 240, a: 32 }, 8);
    const colors = [...transparentMagenta, ...visibleGreen, ...faintBlue];
    const result = extractReferencePalette(rgba(colors), colors.length, 1, { colorCount: 4 });

    expect(result.diagnostics.visiblePixels).toBe(20);
    expect(result.diagnostics.transparentPixels).toBe(100);
    expect(hasNear(result.palette, { r: 255, g: 0, b: 255 }, 10)).toBe(false);
    expect(hasNear(result.palette, { r: 30, g: 190, b: 70 }, 5)).toBe(true);
    expect(result.diagnostics.visibleWeight).toBeCloseTo(12 + 8 * 32 / 255, 8);
  });

  it('preserves meaningful neutral and separate chromatic families', () => {
    const colors = [
      ...repeat({ r: 38, g: 39, b: 41 }, 120),
      ...repeat({ r: 132, g: 134, b: 136 }, 240),
      ...repeat({ r: 224, g: 225, b: 226 }, 120),
      ...repeat({ r: 205, g: 40, b: 48 }, 160),
      ...repeat({ r: 28, g: 82, b: 215 }, 160),
    ];
    const result = extractReferencePalette(rgba(colors), 80, 10, { colorCount: 6 });

    const families = new Set(result.palette.map((color) => {
      const lch = rgbToOklch(color);
      if (lch.c < 0.035) return 'neutral';
      if (lch.h < 25 || lch.h >= 345) return 'red';
      if (lch.h >= 225 && lch.h < 275) return 'blue';
      return 'other';
    }));
    expect(families.has('neutral')).toBe(true);
    expect(families.has('red')).toBe(true);
    expect(families.has('blue')).toBe(true);
    expect(result.diagnostics.neutralSourceFraction).toBeCloseTo(0.6, 2);
    expect(result.diagnostics.meaningfulFamiliesPreserved).toBe(result.diagnostics.meaningfulFamiliesDetected);
  });

  it('clamps requested palette sizes to the supported 4..20 range', () => {
    const colors = Array.from({ length: 64 }, (_, index) => ({
      r: (index * 47) % 256,
      g: (index * 83) % 256,
      b: (index * 131) % 256,
    }));
    const low = extractReferencePalette(rgba(colors), 8, 8, { colorCount: 1, nearDuplicateDistance: 0 });
    const high = extractReferencePalette(rgba(colors), 8, 8, { colorCount: 99, nearDuplicateDistance: 0 });

    expect(low.diagnostics.targetColorCount).toBe(REFERENCE_PALETTE_MIN_COLORS);
    expect(low.palette).toHaveLength(REFERENCE_PALETTE_MIN_COLORS);
    expect(high.diagnostics.targetColorCount).toBe(REFERENCE_PALETTE_MAX_COLORS);
    expect(high.palette).toHaveLength(REFERENCE_PALETTE_MAX_COLORS);
    expect(low.warnings.map((warning) => warning.code)).toContain('color-count-clamped');
    expect(high.warnings.map((warning) => warning.code)).toContain('color-count-clamped');
  });

  it('returns stable bytes, ordering, diagnostics, and warnings for identical input', () => {
    const colors = Array.from({ length: 256 }, (_, index) => ({
      r: (index * 29) % 256,
      g: (index * 71) % 256,
      b: (index * 113) % 256,
      a: index % 11 === 0 ? 0 : 255,
    }));
    const pixels = rgba(colors);
    const first = extractReferencePalette(pixels, 16, 16, { colorCount: 12 });
    const second = extractReferencePalette(pixels, 16, 16, { colorCount: 12 });

    expect(second).toEqual(first);
  });

  it('reports an empty transparent image without inventing colors', () => {
    const result = extractReferencePalette(rgba(repeat({ r: 255, g: 0, b: 255, a: 0 }, 16)), 4, 4);

    expect(result.palette).toEqual([]);
    expect(result.warnings.map((warning) => warning.code)).toContain('no-visible-pixels');
    expect(result.diagnostics.producedColorCount).toBe(0);
  });

  it('rejects malformed dimensions and undersized RGBA buffers', () => {
    expect(() => extractReferencePalette(new Uint8Array(4), 0, 1)).toThrow(/positive integers/i);
    expect(() => extractReferencePalette(new Uint8Array(4), 2, 1)).toThrow(/shorter/i);
  });
});
