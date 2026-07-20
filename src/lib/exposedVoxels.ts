import type { VoxelModel } from '../types';
import {
  buildVoxelIndex,
  MAX_VOXEL_COORDINATE,
  packVoxelCoordinate,
  VOXEL_COORDINATE_LIMIT,
} from './voxelIndex';

const X_STRIDE = 1;
const Y_STRIDE = VOXEL_COORDINATE_LIMIT;
const Z_STRIDE = VOXEL_COORDINATE_LIMIT * VOXEL_COORDINATE_LIMIT;

/**
 * Returns voxels with at least one face adjacent to empty space.
 *
 * The filter preserves the input order and voxel references. Coordinates on
 * the supported grid boundary are exposed without attempting to pack an
 * out-of-range neighbor.
 */
export function getExposedVoxels(voxels: VoxelModel['voxels']): VoxelModel['voxels'] {
  const occupied = buildVoxelIndex(voxels);

  return voxels.filter((voxel) => {
    if (voxel.x === 0 || voxel.x === MAX_VOXEL_COORDINATE
      || voxel.y === 0 || voxel.y === MAX_VOXEL_COORDINATE
      || voxel.z === 0 || voxel.z === MAX_VOXEL_COORDINATE) {
      return true;
    }

    const key = packVoxelCoordinate(voxel);
    return !occupied.has(key - X_STRIDE)
      || !occupied.has(key + X_STRIDE)
      || !occupied.has(key - Y_STRIDE)
      || !occupied.has(key + Y_STRIDE)
      || !occupied.has(key - Z_STRIDE)
      || !occupied.has(key + Z_STRIDE);
  });
}
