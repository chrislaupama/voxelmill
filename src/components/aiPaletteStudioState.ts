import { AI_PALETTE_MAX_COLORS, AI_PALETTE_MIN_COLORS } from '../lib/aiPaletteContract';

export const PALETTE_STUDIO_MIN_COLORS = 4;
export const PALETTE_STUDIO_MAX_COLORS = 20;

export const REFERENCE_IMAGE_MAX_SIDE = 384;
export const REFERENCE_IMAGE_MAX_PIXELS = REFERENCE_IMAGE_MAX_SIDE * REFERENCE_IMAGE_MAX_SIDE;
export const REFERENCE_IMAGE_MAX_FILE_BYTES = 20 * 1024 * 1024;
export const REFERENCE_IMAGE_MAX_SOURCE_SIDE = 8_192;
export const REFERENCE_IMAGE_MAX_SOURCE_PIXELS = 40_000_000;

const REFERENCE_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);
const REFERENCE_IMAGE_EXTENSIONS = /\.(?:png|jpe?g|webp)$/iu;

export function initialAiPaletteTargetSize(modelPaletteSize: number): number {
  const minimum = Math.max(AI_PALETTE_MIN_COLORS, PALETTE_STUDIO_MIN_COLORS);
  const maximum = Math.min(AI_PALETTE_MAX_COLORS, PALETTE_STUDIO_MAX_COLORS);
  return Math.min(maximum, Math.max(minimum, modelPaletteSize));
}

export function isSupportedReferenceImage(file: Pick<File, 'name' | 'type' | 'size'>): boolean {
  if (file.size <= 0 || file.size > REFERENCE_IMAGE_MAX_FILE_BYTES) return false;
  return file.type ? REFERENCE_IMAGE_TYPES.has(file.type.toLowerCase()) : REFERENCE_IMAGE_EXTENSIONS.test(file.name);
}

export function assertSupportedReferenceImageDimensions(
  width: number,
  height: number,
  maximumSide = REFERENCE_IMAGE_MAX_SOURCE_SIDE,
  maximumPixels = REFERENCE_IMAGE_MAX_SOURCE_PIXELS,
): void {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) {
    throw new RangeError('Reference image dimensions must be positive integers.');
  }
  if (!Number.isSafeInteger(maximumSide) || !Number.isSafeInteger(maximumPixels) || maximumSide < 1 || maximumPixels < 1) {
    throw new RangeError('Reference image source bounds must be positive integers.');
  }
  if (width > maximumSide || height > maximumSide || width > Math.floor(maximumPixels / height)) {
    throw new RangeError(`Reference image dimensions are too large. Use an image no larger than ${maximumSide.toLocaleString()} px per side and ${maximumPixels.toLocaleString()} total pixels.`);
  }
}

export function boundedReferenceImageDimensions(
  width: number,
  height: number,
  maximumSide = REFERENCE_IMAGE_MAX_SIDE,
  maximumPixels = REFERENCE_IMAGE_MAX_PIXELS,
): { width: number; height: number } {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new RangeError('Reference image dimensions must be positive numbers.');
  }
  if (!Number.isFinite(maximumSide) || !Number.isFinite(maximumPixels) || maximumSide < 1 || maximumPixels < 1) {
    throw new RangeError('Reference image bounds must be positive numbers.');
  }
  const scale = Math.min(
    1,
    maximumSide / width,
    maximumSide / height,
    Math.sqrt(maximumPixels / (width * height)),
  );
  return {
    width: Math.max(1, Math.floor(width * scale)),
    height: Math.max(1, Math.floor(height * scale)),
  };
}
