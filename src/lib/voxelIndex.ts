import type { Voxel, VoxelCoordinate } from '../types';

const COORDINATE_BITS = 10;
export const VOXEL_COORDINATE_LIMIT = 1 << COORDINATE_BITS;
export const MAX_VOXEL_COORDINATE = VOXEL_COORDINATE_LIMIT - 1;
const COORDINATE_MASK = MAX_VOXEL_COORDINATE;

export interface VoxelIndexEntry {
  position: number;
  voxel: Voxel;
}

const cache = new WeakMap<Voxel[], Map<number, VoxelIndexEntry>>();

export function isSupportedVoxelCoordinate({ x, y, z }: VoxelCoordinate): boolean {
  return Number.isInteger(x) && Number.isInteger(y) && Number.isInteger(z)
    && x >= 0 && y >= 0 && z >= 0
    && x < VOXEL_COORDINATE_LIMIT && y < VOXEL_COORDINATE_LIMIT && z < VOXEL_COORDINATE_LIMIT;
}

export function packVoxelCoordinate({ x, y, z }: VoxelCoordinate): number {
  if (!isSupportedVoxelCoordinate({ x, y, z })) {
    throw new RangeError(`Voxel coordinates must be integers between 0 and ${MAX_VOXEL_COORDINATE}.`);
  }
  return x | (y << COORDINATE_BITS) | (z << (COORDINATE_BITS * 2));
}

export function unpackVoxelCoordinate(key: number): VoxelCoordinate {
  return {
    x: key & COORDINATE_MASK,
    y: (key >> COORDINATE_BITS) & COORDINATE_MASK,
    z: (key >> (COORDINATE_BITS * 2)) & COORDINATE_MASK,
  };
}

export function buildVoxelIndex(voxels: Voxel[]): Map<number, VoxelIndexEntry> {
  const cached = cache.get(voxels);
  if (cached) return cached;
  const index = new Map<number, VoxelIndexEntry>();
  voxels.forEach((voxel, position) => {
    index.set(packVoxelCoordinate(voxel), { voxel, position });
  });
  cache.set(voxels, index);
  return index;
}
