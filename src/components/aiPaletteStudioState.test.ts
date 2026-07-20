import { describe, expect, it } from 'vitest';
import {
  assertSupportedReferenceImageDimensions,
  boundedReferenceImageDimensions,
  initialAiPaletteTargetSize,
  isSupportedReferenceImage,
  REFERENCE_IMAGE_MAX_FILE_BYTES,
  REFERENCE_IMAGE_MAX_SOURCE_PIXELS,
  REFERENCE_IMAGE_MAX_SOURCE_SIDE,
} from './aiPaletteStudioState';

describe('initialAiPaletteTargetSize', () => {
  it('uses the model palette size through the 20-color default', () => {
    expect(initialAiPaletteTargetSize(8)).toBe(8);
    expect(initialAiPaletteTargetSize(16)).toBe(16);
    expect(initialAiPaletteTargetSize(20)).toBe(20);
  });

  it('keeps small palettes above the useful generation minimum', () => {
    expect(initialAiPaletteTargetSize(1)).toBe(4);
    expect(initialAiPaletteTargetSize(4)).toBe(4);
  });

  it('caps larger model palettes at 20 colors', () => {
    expect(initialAiPaletteTargetSize(21)).toBe(20);
    expect(initialAiPaletteTargetSize(32)).toBe(20);
  });
});

describe('reference image input helpers', () => {
  it('accepts only non-empty, bounded PNG, JPEG, and WebP files', () => {
    expect(isSupportedReferenceImage({ name: 'look.png', type: 'image/png', size: 100 })).toBe(true);
    expect(isSupportedReferenceImage({ name: 'look.JPG', type: '', size: 100 })).toBe(true);
    expect(isSupportedReferenceImage({ name: 'look.webp', type: 'image/webp', size: 100 })).toBe(true);
    expect(isSupportedReferenceImage({ name: 'look.gif', type: 'image/gif', size: 100 })).toBe(false);
    expect(isSupportedReferenceImage({ name: 'look.png', type: 'text/plain', size: 100 })).toBe(false);
    expect(isSupportedReferenceImage({ name: 'look.png', type: 'image/png', size: 0 })).toBe(false);
    expect(isSupportedReferenceImage({ name: 'look.png', type: 'image/png', size: REFERENCE_IMAGE_MAX_FILE_BYTES + 1 })).toBe(false);
  });

  it('preserves aspect ratio while bounding both side length and pixel count', () => {
    expect(boundedReferenceImageDimensions(200, 100)).toEqual({ width: 200, height: 100 });
    expect(boundedReferenceImageDimensions(4_000, 2_000)).toEqual({ width: 384, height: 192 });
    expect(boundedReferenceImageDimensions(2_000, 4_000)).toEqual({ width: 192, height: 384 });
    const bounded = boundedReferenceImageDimensions(1_000, 1_000, 1_000, 90_000);
    expect(bounded).toEqual({ width: 300, height: 300 });
    expect(bounded.width * bounded.height).toBeLessThanOrEqual(90_000);
  });

  it('rejects invalid image dimensions and bounds', () => {
    expect(() => boundedReferenceImageDimensions(0, 100)).toThrow(/positive numbers/i);
    expect(() => boundedReferenceImageDimensions(100, Number.NaN)).toThrow(/positive numbers/i);
    expect(() => boundedReferenceImageDimensions(100, 100, 0)).toThrow(/bounds/i);
  });

  it('rejects extreme intrinsic dimensions before allocating a sampling canvas', () => {
    expect(() => assertSupportedReferenceImageDimensions(8_000, 5_000)).not.toThrow();
    expect(() => assertSupportedReferenceImageDimensions(REFERENCE_IMAGE_MAX_SOURCE_SIDE + 1, 1)).toThrow(/too large/i);
    expect(() => assertSupportedReferenceImageDimensions(8_000, 5_001)).toThrow(/too large/i);
    expect(() => assertSupportedReferenceImageDimensions(REFERENCE_IMAGE_MAX_SOURCE_PIXELS, 2)).toThrow(/too large/i);
    expect(() => assertSupportedReferenceImageDimensions(10.5, 100)).toThrow(/positive integers/i);
    expect(() => assertSupportedReferenceImageDimensions(100, 100, 0)).toThrow(/source bounds/i);
  });
});
