import type { RGB, Voxel, VoxelModel } from '../types';
import { perceptualColorDistance } from './palette';

export interface PaletteErrorMetrics {
  mean: number;
  rootMeanSquare: number;
  p95: number;
  max: number;
}

export interface OccupancyMetrics {
  intersection: number;
  actual: number;
  expected: number;
  precision: number;
  recall: number;
  intersectionOverUnion: number;
}

export interface SpatialColorMetrics extends PaletteErrorMetrics {
  matched: number;
  actual: number;
  expected: number;
  coverage: number;
}

const coordinateKey = ({ x, y, z }: Pick<Voxel, 'x' | 'y' | 'z'>) => `${x}:${y}:${z}`;

function summarizeDistances(distances: number[]): PaletteErrorMetrics {
  if (!distances.length) return { mean: 0, rootMeanSquare: 0, p95: 0, max: 0 };
  distances.sort((a, b) => a - b);
  const sum = distances.reduce((total, distance) => total + distance, 0);
  const squareSum = distances.reduce((total, distance) => total + distance * distance, 0);
  return {
    mean: sum / distances.length,
    rootMeanSquare: Math.sqrt(squareSum / distances.length),
    p95: distances[Math.min(distances.length - 1, Math.ceil(distances.length * 0.95) - 1)],
    max: distances[distances.length - 1],
  };
}

export function measurePaletteError(colors: RGB[], palette: RGB[]): PaletteErrorMetrics {
  if (!colors.length) return { mean: 0, rootMeanSquare: 0, p95: 0, max: 0 };
  if (!palette.length) {
    return {
      mean: Number.POSITIVE_INFINITY,
      rootMeanSquare: Number.POSITIVE_INFINITY,
      p95: Number.POSITIVE_INFINITY,
      max: Number.POSITIVE_INFINITY,
    };
  }
  const distances = colors.map((color) => {
    let best = Number.POSITIVE_INFINITY;
    for (const candidate of palette) best = Math.min(best, perceptualColorDistance(color, candidate));
    return best;
  });
  return summarizeDistances(distances);
}

export function compareOccupancy(actual: Voxel[], expected: Voxel[]): OccupancyMetrics {
  const actualKeys = new Set(actual.map(coordinateKey));
  const expectedKeys = new Set(expected.map(coordinateKey));
  let intersection = 0;
  for (const key of actualKeys) if (expectedKeys.has(key)) intersection += 1;
  const union = actualKeys.size + expectedKeys.size - intersection;
  return {
    intersection,
    actual: actualKeys.size,
    expected: expectedKeys.size,
    precision: actualKeys.size ? intersection / actualKeys.size : expectedKeys.size ? 0 : 1,
    recall: expectedKeys.size ? intersection / expectedKeys.size : actualKeys.size ? 0 : 1,
    intersectionOverUnion: union ? intersection / union : 1,
  };
}

export function compareVoxelColors(actual: Voxel[], expected: Voxel[]): SpatialColorMetrics {
  const actualByCoordinate = new Map(actual.map((voxel) => [coordinateKey(voxel), voxel]));
  const distances: number[] = [];
  for (const reference of expected) {
    const voxel = actualByCoordinate.get(coordinateKey(reference));
    if (voxel) distances.push(perceptualColorDistance(voxel, reference));
  }
  const distribution = distances.length
    ? summarizeDistances(distances)
    : expected.length
      ? {
          mean: Number.POSITIVE_INFINITY,
          rootMeanSquare: Number.POSITIVE_INFINITY,
          p95: Number.POSITIVE_INFINITY,
          max: Number.POSITIVE_INFINITY,
        }
      : summarizeDistances([]);
  return {
    ...distribution,
    matched: distances.length,
    actual: actualByCoordinate.size,
    expected: new Set(expected.map(coordinateKey)).size,
    coverage: expected.length ? distances.length / new Set(expected.map(coordinateKey)).size : actual.length ? 0 : 1,
  };
}

export function voxelModelFingerprint(model: VoxelModel): string {
  const voxels = [...model.voxels].sort((a, b) =>
    a.z - b.z || a.y - b.y || a.x - b.x || a.colorIndex - b.colorIndex,
  );
  let hash = 0x811c9dc5;
  const update = (value: number) => {
    hash ^= value & 0xff;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  };
  for (const dimension of [model.size.x, model.size.y, model.size.z]) {
    update(dimension);
    update(dimension >>> 8);
  }
  for (const color of model.palette) {
    update(color.r);
    update(color.g);
    update(color.b);
  }
  for (const voxel of voxels) {
    update(voxel.x);
    update(voxel.y);
    update(voxel.z);
    update(voxel.colorIndex);
  }
  return hash.toString(16).padStart(8, '0');
}
