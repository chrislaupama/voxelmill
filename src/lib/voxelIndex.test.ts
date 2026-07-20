import { describe, expect, it } from 'vitest';
import type { Voxel } from '../types';
import {
  buildVoxelIndex,
  isSupportedVoxelCoordinate,
  MAX_VOXEL_COORDINATE,
  packVoxelCoordinate,
  unpackVoxelCoordinate,
  VOXEL_COORDINATE_LIMIT,
} from './voxelIndex';

describe('packed voxel coordinates', () => {
  it('round-trips every coordinate at the supported boundary', () => {
    const coordinate = { x: MAX_VOXEL_COORDINATE, y: MAX_VOXEL_COORDINATE, z: MAX_VOXEL_COORDINATE };
    expect(unpackVoxelCoordinate(packVoxelCoordinate(coordinate))).toEqual(coordinate);
  });

  it('rejects coordinates that cannot be represented without collisions', () => {
    expect(() => packVoxelCoordinate({ x: VOXEL_COORDINATE_LIMIT, y: 0, z: 0 })).toThrow(RangeError);
    expect(() => packVoxelCoordinate({ x: 0, y: VOXEL_COORDINATE_LIMIT, z: 0 })).toThrow(RangeError);
    expect(() => packVoxelCoordinate({ x: 0, y: 0, z: VOXEL_COORDINATE_LIMIT })).toThrow(RangeError);
    expect(() => packVoxelCoordinate({ x: -1, y: 0, z: 0 })).toThrow(RangeError);
    expect(() => packVoxelCoordinate({ x: 0.5, y: 0, z: 0 })).toThrow(RangeError);
  });

  it('exposes the same coordinate contract without packing', () => {
    expect(isSupportedVoxelCoordinate({ x: 0, y: 0, z: 0 })).toBe(true);
    expect(isSupportedVoxelCoordinate({
      x: MAX_VOXEL_COORDINATE,
      y: MAX_VOXEL_COORDINATE,
      z: MAX_VOXEL_COORDINATE,
    })).toBe(true);
    expect(isSupportedVoxelCoordinate({ x: VOXEL_COORDINATE_LIMIT, y: 0, z: 0 })).toBe(false);
  });

  it('caches coordinate lookups by immutable voxel array identity', () => {
    const voxels: Voxel[] = [{ x: 2, y: 3, z: 4, r: 1, g: 2, b: 3, colorIndex: 0 }];
    const first = buildVoxelIndex(voxels);
    expect(buildVoxelIndex(voxels)).toBe(first);
    expect(first.get(packVoxelCoordinate(voxels[0]))).toEqual({ position: 0, voxel: voxels[0] });
  });
});
