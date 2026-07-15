import type { RGB, Voxel, VoxelModel } from '../types';

interface VoxelChange {
  coordinate: string;
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

const coordinateKey = ({ x, y, z }: Pick<Voxel, 'x' | 'y' | 'z'>) => `${x}:${y}:${z}`;

const sameVoxel = (a: Voxel | undefined, b: Voxel | undefined) =>
  a === b || Boolean(a && b
    && a.x === b.x && a.y === b.y && a.z === b.z
    && a.colorIndex === b.colorIndex && a.r === b.r && a.g === b.g && a.b === b.b);

export function createVoxelPatch(before: VoxelModel, after: VoxelModel): VoxelPatch {
  const beforeByCoordinate = new Map(before.voxels.map((voxel) => [coordinateKey(voxel), voxel]));
  const afterByCoordinate = new Map(after.voxels.map((voxel) => [coordinateKey(voxel), voxel]));
  const coordinates = new Set([...beforeByCoordinate.keys(), ...afterByCoordinate.keys()]);
  const changes: VoxelChange[] = [];
  for (const coordinate of coordinates) {
    const previous = beforeByCoordinate.get(coordinate);
    const next = afterByCoordinate.get(coordinate);
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
  const voxels = new Map(model.voxels.map((voxel) => [coordinateKey(voxel), voxel]));
  for (const change of patch.changes) {
    const target = direction === 'undo' ? change.before : change.after;
    if (target) voxels.set(change.coordinate, target);
    else voxels.delete(change.coordinate);
  }
  return {
    ...model,
    voxels: [...voxels.values()],
    palette: direction === 'undo' ? patch.beforePalette : patch.afterPalette,
    size: direction === 'undo' ? patch.beforeSize : patch.afterSize,
  };
}
