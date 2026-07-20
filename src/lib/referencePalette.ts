import type { RGB } from '../types';
import {
  linearToSrgb,
  oklabToRgb,
  perceptualColorDistance,
  rgbToOklab,
  rgbToOklch,
  srgbToLinear,
  type OklabColor,
} from './palette';

export const REFERENCE_PALETTE_MIN_COLORS = 4;
export const REFERENCE_PALETTE_MAX_COLORS = 20;

const HISTOGRAM_CHANNEL_BITS = 5;
const HISTOGRAM_CHANNEL_SHIFT = 8 - HISTOGRAM_CHANNEL_BITS;
const DEFAULT_COLOR_COUNT = 12;
const DEFAULT_ALPHA_THRESHOLD = 8;
const DEFAULT_NEAR_DUPLICATE_DISTANCE = 2.4;
const DEFAULT_MIN_ACCENT_FRACTION = 0.005;
const KMEANS_ITERATIONS = 12;

export interface ReferencePaletteOptions {
  /** Desired number of swatches. Values outside 4..20 are clamped. */
  colorCount?: number;
  /** Pixels below this 0..255 alpha value are ignored. Remaining pixels are alpha weighted. */
  alphaThreshold?: number;
  /** Minimum OKLab delta-E used when removing effectively duplicate swatches. */
  nearDuplicateDistance?: number;
  /** Smallest image-weight fraction that may reserve a hue-family seed. */
  minAccentFraction?: number;
}

export type ReferencePaletteWarningCode =
  | 'color-count-clamped'
  | 'no-visible-pixels'
  | 'limited-color-diversity'
  | 'family-loss'
  | 'high-reconstruction-error';

export interface ReferencePaletteWarning {
  code: ReferencePaletteWarningCode;
  message: string;
}

export interface ReferencePaletteSwatchDiagnostic {
  color: RGB;
  /** Fraction of visible, alpha-weighted source pixels represented by this swatch. */
  coverage: number;
}

export interface ReferencePaletteDiagnostics {
  sourcePixels: number;
  visiblePixels: number;
  transparentPixels: number;
  /** Alpha-weighted visible pixel count. */
  visibleWeight: number;
  /** Number of populated five-bit-per-channel histogram cells. */
  quantizedColorCount: number;
  requestedColorCount: number;
  targetColorCount: number;
  producedColorCount: number;
  neutralSourceFraction: number;
  chromaticSourceFraction: number;
  meaningfulFamiliesDetected: number;
  meaningfulFamiliesPreserved: number;
  accentFamiliesDetected: number;
  accentFamiliesPreserved: number;
  meanPerceptualError: number;
  p95PerceptualError: number;
  swatches: ReferencePaletteSwatchDiagnostic[];
}

export interface ReferencePaletteResult {
  palette: RGB[];
  diagnostics: ReferencePaletteDiagnostics;
  warnings: ReferencePaletteWarning[];
}

interface HistogramCell {
  key: number;
  pixels: number;
  weight: number;
  linearR: number;
  linearG: number;
  linearB: number;
}

interface WeightedColor {
  key: number;
  pixels: number;
  weight: number;
  rgb: RGB;
  lab: OklabColor;
  family: ColorFamily;
}

interface FamilySummary {
  family: ColorFamily;
  entries: WeightedColor[];
  pixels: number;
  weight: number;
  averageChroma: number;
  representative: WeightedColor;
  meaningful: boolean;
}

interface PaletteCandidate {
  color: RGB;
  lab: OklabColor;
  weight: number;
}

type ColorFamily = 'neutral' | 'red' | 'orange' | 'yellow' | 'green' | 'cyan' | 'blue' | 'purple' | 'pink';

const SRGB_LINEAR_LOOKUP = Array.from({ length: 256 }, (_, value) => srgbToLinear(value));

const clamp = (value: number, minimum: number, maximum: number) => Math.max(minimum, Math.min(maximum, value));

const labDistanceSquared = (a: OklabColor, b: OklabColor) => {
  const dl = (a.l - b.l) * 1.15;
  const da = a.a - b.a;
  const db = a.b - b.b;
  return dl * dl + da * da + db * db;
};

const labDistance = (a: OklabColor, b: OklabColor) => Math.sqrt(labDistanceSquared(a, b)) * 100;

function classifyFamily(color: RGB): ColorFamily {
  const { c, h } = rgbToOklch(color);
  if (c < 0.035) return 'neutral';
  if (h < 25 || h >= 345) return 'red';
  if (h < 70) return 'orange';
  if (h < 115) return 'yellow';
  if (h < 175) return 'green';
  if (h < 225) return 'cyan';
  if (h < 275) return 'blue';
  if (h < 325) return 'purple';
  return 'pink';
}

function normalizeOptions(options: ReferencePaletteOptions, warnings: ReferencePaletteWarning[]) {
  const rawCount = options.colorCount ?? DEFAULT_COLOR_COUNT;
  const finiteCount = Number.isFinite(rawCount) ? Math.round(rawCount) : DEFAULT_COLOR_COUNT;
  const targetColorCount = clamp(finiteCount, REFERENCE_PALETTE_MIN_COLORS, REFERENCE_PALETTE_MAX_COLORS);
  if (finiteCount !== targetColorCount || !Number.isFinite(rawCount)) {
    warnings.push({
      code: 'color-count-clamped',
      message: `Reference palettes support ${REFERENCE_PALETTE_MIN_COLORS} to ${REFERENCE_PALETTE_MAX_COLORS} colors; using ${targetColorCount}.`,
    });
  }
  return {
    requestedColorCount: finiteCount,
    targetColorCount,
    alphaThreshold: clamp(
      Number.isFinite(options.alphaThreshold) ? Math.round(options.alphaThreshold as number) : DEFAULT_ALPHA_THRESHOLD,
      0,
      255,
    ),
    nearDuplicateDistance: clamp(
      Number.isFinite(options.nearDuplicateDistance) ? options.nearDuplicateDistance as number : DEFAULT_NEAR_DUPLICATE_DISTANCE,
      0,
      25,
    ),
    minAccentFraction: clamp(
      Number.isFinite(options.minAccentFraction) ? options.minAccentFraction as number : DEFAULT_MIN_ACCENT_FRACTION,
      0,
      0.25,
    ),
  };
}

function validatePixels(pixels: ArrayLike<number>, width: number, height: number) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new RangeError('Reference image dimensions must be positive integers.');
  }
  const pixelCount = width * height;
  if (!Number.isSafeInteger(pixelCount) || pixels.length < pixelCount * 4) {
    throw new RangeError('Reference image RGBA data is shorter than its dimensions require.');
  }
  return pixelCount;
}

function buildHistogram(
  pixels: ArrayLike<number>,
  pixelCount: number,
  alphaThreshold: number,
): { cells: HistogramCell[]; visiblePixels: number; visibleWeight: number } {
  const histogram = new Map<number, HistogramCell>();
  let visiblePixels = 0;
  let visibleWeight = 0;

  // A bounded 32^3 histogram keeps clustering independent of image resolution while
  // this single pass still notices small accents that a grid downsample can skip.
  for (let pixelIndex = 0; pixelIndex < pixelCount; pixelIndex += 1) {
    const offset = pixelIndex * 4;
    const alpha = clamp(Number(pixels[offset + 3]) || 0, 0, 255);
    if (alpha < alphaThreshold || alpha === 0) continue;
    const r = clamp(Math.round(Number(pixels[offset]) || 0), 0, 255);
    const g = clamp(Math.round(Number(pixels[offset + 1]) || 0), 0, 255);
    const b = clamp(Math.round(Number(pixels[offset + 2]) || 0), 0, 255);
    const weight = alpha / 255;
    const key = ((r >> HISTOGRAM_CHANNEL_SHIFT) << (HISTOGRAM_CHANNEL_BITS * 2))
      | ((g >> HISTOGRAM_CHANNEL_SHIFT) << HISTOGRAM_CHANNEL_BITS)
      | (b >> HISTOGRAM_CHANNEL_SHIFT);
    const existing = histogram.get(key);
    if (existing) {
      existing.pixels += 1;
      existing.weight += weight;
      existing.linearR += SRGB_LINEAR_LOOKUP[r] * weight;
      existing.linearG += SRGB_LINEAR_LOOKUP[g] * weight;
      existing.linearB += SRGB_LINEAR_LOOKUP[b] * weight;
    } else {
      histogram.set(key, {
        key,
        pixels: 1,
        weight,
        linearR: SRGB_LINEAR_LOOKUP[r] * weight,
        linearG: SRGB_LINEAR_LOOKUP[g] * weight,
        linearB: SRGB_LINEAR_LOOKUP[b] * weight,
      });
    }
    visiblePixels += 1;
    visibleWeight += weight;
  }

  return { cells: [...histogram.values()].sort((a, b) => a.key - b.key), visiblePixels, visibleWeight };
}

function histogramColors(cells: HistogramCell[]): WeightedColor[] {
  return cells.map((cell) => {
    const rgb = {
      r: linearToSrgb(cell.linearR / cell.weight),
      g: linearToSrgb(cell.linearG / cell.weight),
      b: linearToSrgb(cell.linearB / cell.weight),
    };
    return {
      key: cell.key,
      pixels: cell.pixels,
      weight: cell.weight,
      rgb,
      lab: rgbToOklab(rgb),
      family: classifyFamily(rgb),
    };
  });
}

function familySummaries(entries: WeightedColor[], totalWeight: number, minAccentFraction: number): FamilySummary[] {
  const grouped = new Map<ColorFamily, WeightedColor[]>();
  for (const entry of entries) {
    const group = grouped.get(entry.family);
    if (group) group.push(entry);
    else grouped.set(entry.family, [entry]);
  }

  return [...grouped.entries()].map(([family, familyEntries]) => {
    const weight = familyEntries.reduce((sum, entry) => sum + entry.weight, 0);
    const pixels = familyEntries.reduce((sum, entry) => sum + entry.pixels, 0);
    const centroid = familyEntries.reduce(
      (sum, entry) => ({
        l: sum.l + entry.lab.l * entry.weight,
        a: sum.a + entry.lab.a * entry.weight,
        b: sum.b + entry.lab.b * entry.weight,
      }),
      { l: 0, a: 0, b: 0 },
    );
    centroid.l /= weight;
    centroid.a /= weight;
    centroid.b /= weight;
    const representative = familyEntries.reduce((best, entry) => {
      const distance = labDistanceSquared(entry.lab, centroid);
      const bestDistance = labDistanceSquared(best.lab, centroid);
      if (distance < bestDistance) return entry;
      return distance === bestDistance && entry.weight > best.weight ? entry : best;
    }, familyEntries[0]);
    const averageChroma = familyEntries.reduce(
      (sum, entry) => sum + rgbToOklch(entry.rgb).c * entry.weight,
      0,
    ) / weight;
    return {
      family,
      entries: familyEntries,
      pixels,
      weight,
      averageChroma,
      representative,
      meaningful: weight / totalWeight >= minAccentFraction,
    };
  });
}

function initialCentroids(
  entries: WeightedColor[],
  targetSize: number,
  families: FamilySummary[],
  totalWeight: number,
): OklabColor[] {
  const dominant = entries.reduce((best, entry) => entry.weight > best.weight ? entry : best, entries[0]);
  const seeds: WeightedColor[] = [dominant];
  const seedKeys = new Set([dominant.key]);
  const addSeed = (entry: WeightedColor | undefined) => {
    if (entry && seeds.length < targetSize && !seedKeys.has(entry.key)) {
      seeds.push(entry);
      seedKeys.add(entry.key);
    }
  };

  // Keep a meaningful neutral family and distinct chromatic families from being
  // swallowed by a much larger background before global Lloyd refinement starts.
  const neutral = families.find((family) => family.family === 'neutral' && family.meaningful);
  addSeed(neutral?.representative);
  const chromaticFamilies = families
    .filter((family) => family.family !== 'neutral' && family.meaningful)
    .sort((a, b) => {
      const aFraction = a.weight / totalWeight;
      const bFraction = b.weight / totalWeight;
      const aDistance = Math.sqrt(labDistanceSquared(a.representative.lab, dominant.lab));
      const bDistance = Math.sqrt(labDistanceSquared(b.representative.lab, dominant.lab));
      const aScore = Math.sqrt(aFraction) * (0.35 + aDistance) * (0.75 + a.averageChroma * 3);
      const bScore = Math.sqrt(bFraction) * (0.35 + bDistance) * (0.75 + b.averageChroma * 3);
      return bScore - aScore || b.weight - a.weight || a.representative.key - b.representative.key;
    });
  for (const family of chromaticFamilies) addSeed(family.representative);

  // Population-aware farthest-point seeds add useful tonal variation without
  // promoting isolated texture noise as aggressively as unweighted k-means++.
  while (seeds.length < targetSize) {
    let best: WeightedColor | undefined;
    let bestScore = -1;
    for (const entry of entries) {
      if (seedKeys.has(entry.key)) continue;
      let nearest = Number.POSITIVE_INFINITY;
      for (const seed of seeds) nearest = Math.min(nearest, labDistanceSquared(entry.lab, seed.lab));
      const score = nearest * Math.sqrt(entry.weight);
      if (score > bestScore) {
        best = entry;
        bestScore = score;
      }
    }
    if (!best) break;
    addSeed(best);
  }
  return seeds.map((seed) => ({ ...seed.lab }));
}

function clusterColors(entries: WeightedColor[], targetSize: number, families: FamilySummary[], totalWeight: number) {
  let centroids = initialCentroids(entries, targetSize, families, totalWeight);
  let clusterWeights = centroids.map(() => 0);
  for (let iteration = 0; iteration < KMEANS_ITERATIONS; iteration += 1) {
    const sums = centroids.map(() => ({ l: 0, a: 0, b: 0, weight: 0 }));
    for (const entry of entries) {
      let bestIndex = 0;
      let bestDistance = Number.POSITIVE_INFINITY;
      for (let centroidIndex = 0; centroidIndex < centroids.length; centroidIndex += 1) {
        const distance = labDistanceSquared(entry.lab, centroids[centroidIndex]);
        if (distance < bestDistance) {
          bestDistance = distance;
          bestIndex = centroidIndex;
        }
      }
      const sum = sums[bestIndex];
      sum.l += entry.lab.l * entry.weight;
      sum.a += entry.lab.a * entry.weight;
      sum.b += entry.lab.b * entry.weight;
      sum.weight += entry.weight;
    }
    clusterWeights = sums.map((sum) => sum.weight);
    centroids = centroids.map((centroid, index) => {
      const sum = sums[index];
      return sum.weight > 0
        ? { l: sum.l / sum.weight, a: sum.a / sum.weight, b: sum.b / sum.weight }
        : centroid;
    });
  }
  return centroids.map((lab, index) => ({ color: oklabToRgb(lab), lab, weight: clusterWeights[index] }));
}

function removeNearDuplicates(
  candidates: PaletteCandidate[],
  entries: WeightedColor[],
  targetSize: number,
  minimumDistance: number,
): PaletteCandidate[] {
  const distinct: PaletteCandidate[] = [];
  const ordered = candidates.map((candidate) => ({ ...candidate, lab: rgbToOklab(candidate.color) })).sort((a, b) => b.weight - a.weight
    || a.color.r - b.color.r || a.color.g - b.color.g || a.color.b - b.color.b);
  for (const candidate of ordered) {
    if (distinct.every((existing) => labDistance(existing.lab, candidate.lab) >= minimumDistance)) {
      distinct.push(candidate);
    }
  }

  while (distinct.length < targetSize) {
    let best: WeightedColor | undefined;
    let bestScore = -1;
    for (const entry of entries) {
      let nearest = Number.POSITIVE_INFINITY;
      for (const existing of distinct) nearest = Math.min(nearest, labDistance(entry.lab, existing.lab));
      if (nearest < minimumDistance) continue;
      const score = nearest * nearest * Math.sqrt(entry.weight);
      if (score > bestScore) {
        best = entry;
        bestScore = score;
      }
    }
    if (!best) break;
    distinct.push({ color: best.rgb, lab: best.lab, weight: best.weight });
  }
  return distinct;
}

function orderPalette(candidates: PaletteCandidate[]): RGB[] {
  return [...candidates]
    .sort((a, b) => {
      const aLch = rgbToOklch(a.color);
      const bLch = rgbToOklch(b.color);
      return aLch.l - bLch.l || aLch.h - bLch.h
        || a.color.r - b.color.r || a.color.g - b.color.g || a.color.b - b.color.b;
    })
    .map(({ color }) => color);
}

function paletteMetrics(entries: WeightedColor[], palette: RGB[], totalWeight: number) {
  const swatchWeights = palette.map(() => 0);
  const paletteLabs = palette.map(rgbToOklab);
  const errors: Array<{ distance: number; weight: number }> = [];
  let weightedError = 0;
  for (const entry of entries) {
    let bestIndex = 0;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (let index = 0; index < palette.length; index += 1) {
      const distance = labDistance(entry.lab, paletteLabs[index]);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestIndex = index;
      }
    }
    swatchWeights[bestIndex] += entry.weight;
    weightedError += bestDistance * entry.weight;
    errors.push({ distance: bestDistance, weight: entry.weight });
  }
  errors.sort((a, b) => a.distance - b.distance);
  let cumulative = 0;
  let p95 = 0;
  for (const error of errors) {
    cumulative += error.weight;
    p95 = error.distance;
    if (cumulative >= totalWeight * 0.95) break;
  }
  return {
    mean: totalWeight ? weightedError / totalWeight : 0,
    p95,
    swatches: palette.map((color, index) => ({ color, coverage: totalWeight ? swatchWeights[index] / totalWeight : 0 })),
  };
}

function familyPreservation(families: FamilySummary[], palette: RGB[]) {
  const meaningful = families.filter((family) => family.meaningful);
  const accents = meaningful.filter((family) => family.family !== 'neutral' && family.weight
    < families.reduce((sum, candidate) => sum + candidate.weight, 0) * 0.1);
  const isPreserved = (family: FamilySummary) => palette.some((color) => {
    if (family.family === 'neutral') return classifyFamily(color) === 'neutral'
      && perceptualColorDistance(color, family.representative.rgb) <= 16;
    return classifyFamily(color) === family.family
      && perceptualColorDistance(color, family.representative.rgb) <= 18;
  });
  return {
    meaningfulDetected: meaningful.length,
    meaningfulPreserved: meaningful.filter(isPreserved).length,
    accentsDetected: accents.length,
    accentsPreserved: accents.filter(isPreserved).length,
  };
}

function emptyDiagnostics(
  pixelCount: number,
  requestedColorCount: number,
  targetColorCount: number,
): ReferencePaletteDiagnostics {
  return {
    sourcePixels: pixelCount,
    visiblePixels: 0,
    transparentPixels: pixelCount,
    visibleWeight: 0,
    quantizedColorCount: 0,
    requestedColorCount,
    targetColorCount,
    producedColorCount: 0,
    neutralSourceFraction: 0,
    chromaticSourceFraction: 0,
    meaningfulFamiliesDetected: 0,
    meaningfulFamiliesPreserved: 0,
    accentFamiliesDetected: 0,
    accentFamiliesPreserved: 0,
    meanPerceptualError: 0,
    p95PerceptualError: 0,
    swatches: [],
  };
}

/**
 * Extracts a compact voxel-art palette locally from RGBA image pixels.
 *
 * The reducer first builds a bounded, alpha-weighted color histogram, then uses
 * hue-family-aware seeds and population-weighted OKLab clustering. No image data
 * leaves the caller and the result is deterministic for identical input/options.
 */
export function extractReferencePalette(
  pixels: ArrayLike<number>,
  width: number,
  height: number,
  options: ReferencePaletteOptions = {},
): ReferencePaletteResult {
  const pixelCount = validatePixels(pixels, width, height);
  const warnings: ReferencePaletteWarning[] = [];
  const normalized = normalizeOptions(options, warnings);
  const histogram = buildHistogram(pixels, pixelCount, normalized.alphaThreshold);
  if (!histogram.cells.length) {
    warnings.push({ code: 'no-visible-pixels', message: 'The reference image has no visible pixels to sample.' });
    return {
      palette: [],
      diagnostics: emptyDiagnostics(pixelCount, normalized.requestedColorCount, normalized.targetColorCount),
      warnings,
    };
  }

  const entries = histogramColors(histogram.cells);
  const targetSize = Math.min(normalized.targetColorCount, entries.length);
  const families = familySummaries(entries, histogram.visibleWeight, normalized.minAccentFraction);
  const rawCandidates = entries.length <= targetSize
    ? entries.map((entry) => ({ color: entry.rgb, lab: entry.lab, weight: entry.weight }))
    : clusterColors(entries, targetSize, families, histogram.visibleWeight);
  const candidates = removeNearDuplicates(
    rawCandidates,
    entries,
    targetSize,
    normalized.nearDuplicateDistance,
  );
  const palette = orderPalette(candidates);
  const metrics = paletteMetrics(entries, palette, histogram.visibleWeight);
  const familyMetrics = familyPreservation(families, palette);
  const neutralWeight = families.find((family) => family.family === 'neutral')?.weight ?? 0;

  if (palette.length < normalized.targetColorCount) {
    warnings.push({
      code: 'limited-color-diversity',
      message: `The reference contains only ${palette.length} perceptually distinct colors at this tolerance.`,
    });
  }
  if (familyMetrics.meaningfulPreserved < familyMetrics.meaningfulDetected) {
    warnings.push({
      code: 'family-loss',
      message: `${familyMetrics.meaningfulDetected - familyMetrics.meaningfulPreserved} meaningful color ${familyMetrics.meaningfulDetected - familyMetrics.meaningfulPreserved === 1 ? 'family was' : 'families were'} compressed by the requested palette size.`,
    });
  }
  if (metrics.mean > 8 || metrics.p95 > 16) {
    warnings.push({
      code: 'high-reconstruction-error',
      message: 'This image has more color variation than the selected palette can represent cleanly.',
    });
  }

  return {
    palette,
    diagnostics: {
      sourcePixels: pixelCount,
      visiblePixels: histogram.visiblePixels,
      transparentPixels: pixelCount - histogram.visiblePixels,
      visibleWeight: histogram.visibleWeight,
      quantizedColorCount: entries.length,
      requestedColorCount: normalized.requestedColorCount,
      targetColorCount: normalized.targetColorCount,
      producedColorCount: palette.length,
      neutralSourceFraction: neutralWeight / histogram.visibleWeight,
      chromaticSourceFraction: 1 - neutralWeight / histogram.visibleWeight,
      meaningfulFamiliesDetected: familyMetrics.meaningfulDetected,
      meaningfulFamiliesPreserved: familyMetrics.meaningfulPreserved,
      accentFamiliesDetected: familyMetrics.accentsDetected,
      accentFamiliesPreserved: familyMetrics.accentsPreserved,
      meanPerceptualError: metrics.mean,
      p95PerceptualError: metrics.p95,
      swatches: metrics.swatches,
    },
    warnings,
  };
}
