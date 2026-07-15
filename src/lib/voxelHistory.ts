import type { RGB, Voxel, VoxelModel } from '../types';
import { buildVoxelIndex, packVoxelCoordinate } from './voxelIndex';

interface VoxelChange {
  coordinate: number;
  before?: Voxel;
  after?: Voxel;
}

export interface VoxelPatch {
  changes: VoxelChange[];
  beforePalette: RGB[];
  afterPalette: RGB[];
  beforeSize: VoxelModel['size'];
  afterSize: VoxelModel['size'];
}

const sameVoxel = (a: Voxel | undefined, b: Voxel | undefined) =>
  a === b || Boolean(a && b
    && a.x === b.x && a.y === b.y && a.z === b.z
    && a.colorIndex === b.colorIndex && a.r === b.r && a.g === b.g && a.b === b.b);

export function createVoxelPatch(before: VoxelModel, after: VoxelModel): VoxelPatch {
  const beforeByCoordinate = buildVoxelIndex(before.voxels);
  const afterByCoordinate = buildVoxelIndex(after.voxels);
  const coordinates = new Set([...beforeByCoordinate.keys(), ...afterByCoordinate.keys()]);
  const changes: VoxelChange[] = [];
  for (const coordinate of coordinates) {
    const previous = beforeByCoordinate.get(coordinate)?.voxel;
    const next = afterByCoordinate.get(coordinate)?.voxel;
    if (!sameVoxel(previous, next)) changes.push({ coordinate, before: previous, after: next });
  }
  return {
    changes,
    beforePalette: before.palette,
    afterPalette: after.palette,
    beforeSize: before.size,
    afterSize: after.size,
  };
}

export function applyVoxelPatch(model: VoxelModel, patch: VoxelPatch, direction: 'undo' | 'redo'): VoxelModel {
  const voxels = new Map([...buildVoxelIndex(model.voxels)].map(([coordinate, entry]) => [coordinate, entry.voxel]));
  for (const change of patch.changes) {
    const target = direction === 'undo' ? change.before : change.after;
    if (target) voxels.set(packVoxelCoordinate(target), target);
    else voxels.delete(change.coordinate);
  }
  return {
    ...model,
    voxels: [...voxels.values()],
    palette: direction === 'undo' ? patch.beforePalette : patch.afterPalette,
    size: direction === 'undo' ? patch.beforeSize : patch.afterSize,
  };
}
