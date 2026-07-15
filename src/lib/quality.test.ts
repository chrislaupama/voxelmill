import { describe, expect, it } from 'vitest';
import type { Voxel, VoxelModel } from '../types';
import { compareOccupancy, measurePaletteError, voxelModelFingerprint } from './quality';

const voxel = (x: number, y = 0, z = 0, colorIndex = 0): Voxel => ({
  x,
  y,
  z,
  colorIndex,
  r: colorIndex ? 0 : 255,
  g: 0,
  b: colorIndex ? 255 : 0,
});

describe('conversion quality metrics', () => {
  it('reports zero error when every sampled color is represented exactly', () => {
    const colors = [{ r: 255, g: 0, b: 0 }, { r: 0, g: 0, b: 255 }];
    expect(measurePaletteError(colors, colors)).toEqual({ mean: 0, rootMeanSquare: 0, p95: 0, max: 0 });
  });

  it('reports perceptual palette error distributions', () => {
    const metrics = measurePaletteError(
      [{ r: 255, g: 0, b: 0 }, { r: 240, g: 10, b: 10 }, { r: 0, g: 0, b: 255 }],
      [{ r: 255, g: 0, b: 0 }],
    );
    expect(metrics.mean).toBeGreaterThan(10);
    expect(metrics.max).toBeGreaterThan(metrics.mean);
    expect(metrics.p95).toBe(metrics.max);
  });

  it('measures precision, recall, and intersection-over-union for voxel occupancy', () => {
    const metrics = compareOccupancy([voxel(0), voxel(1), voxel(2)], [voxel(1), voxel(2), voxel(3)]);
    expect(metrics).toMatchObject({ intersection: 2, actual: 3, expected: 3 });
    expect(metrics.precision).toBeCloseTo(2 / 3);
    expect(metrics.recall).toBeCloseTo(2 / 3);
    expect(metrics.intersectionOverUnion).toBeCloseTo(0.5);
  });

  it('fingerprints model content independently of voxel ordering', () => {
    const makeModel = (voxels: Voxel[]): VoxelModel => ({
      voxels,
      palette: [{ r: 255, g: 0, b: 0 }, { r: 0, g: 0, b: 255 }],
      size: { x: 4, y: 2, z: 2 },
      voxelSize: 0.25,
      sourceName: 'quality.glb',
    });
    expect(voxelModelFingerprint(makeModel([voxel(0), voxel(1, 0, 0, 1)])))
      .toBe(voxelModelFingerprint(makeModel([voxel(1, 0, 0, 1), voxel(0)])));
    expect(voxelModelFingerprint(makeModel([voxel(0)])))
      .not.toBe(voxelModelFingerprint(makeModel([voxel(1)])));
  });
});
