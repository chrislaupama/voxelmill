import type { Voxel, VoxelCoordinate } from '../types';

const COORDINATE_BITS = 10;
const COORDINATE_LIMIT = 1 << COORDINATE_BITS;
const COORDINATE_MASK = COORDINATE_LIMIT - 1;

export interface VoxelIndexEntry {
  position: number;
  voxel: Voxel;
}

const cache = new WeakMap<Voxel[], Map<number, VoxelIndexEntry>>();

export function packVoxelCoordinate({ x, y, z }: VoxelCoordinate): number {
  if (!Number.isInteger(x) || !Number.isInteger(y) || !Number.isInteger(z)
    || x < 0 || y < 0 || z < 0
    || x >= COORDINATE_LIMIT || y >= COORDINATE_LIMIT || z >= COORDINATE_LIMIT) {
    throw new RangeError(`Voxel coordinates must be integers between 0 and ${COORDINATE_LIMIT - 1}.`);
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
