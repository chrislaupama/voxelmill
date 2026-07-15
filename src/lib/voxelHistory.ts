import type { RGB, Voxel, VoxelModel } from '../types';
import { buildVoxelIndex, packVoxelCoordinate } from './voxelIndex';

interface VoxelChange {
  coordinate: number;
  before?: Voxel;
  after?: Voxel;
}

interface VoxelPatchBase {
  beforePalette: RGB[];
  afterPalette: RGB[];
  beforeSize: VoxelModel['size'];
  afterSize: VoxelModel['size'];
}

export interface GeometryVoxelPatch extends VoxelPatchBase {
  kind: 'geometry';
  changes: VoxelChange[];
}

export interface RecolorVoxelPatch extends VoxelPatchBase {
  kind: 'recolor';
  coordinates: Uint32Array;
  beforeIndices: Uint8Array;
  afterIndices: Uint8Array;
}

export type VoxelPatch = GeometryVoxelPatch | RecolorVoxelPatch;

const sameVoxel = (a: Voxel | undefined, b: Voxel | undefined) =>
  a === b || Boolean(a && b
    && a.x === b.x && a.y === b.y && a.z === b.z
    && a.colorIndex === b.colorIndex && a.r === b.r && a.g === b.g && a.b === b.b);

export function createVoxelPatch(before: VoxelModel, after: VoxelModel): VoxelPatch {
  const beforeByCoordinate = buildVoxelIndex(before.voxels);
  const afterByCoordinate = buildVoxelIndex(after.voxels);
  const coordinates = new Set([...beforeByCoordinate.keys(), ...afterByCoordinate.keys()]);
  const sameGeometry = beforeByCoordinate.size === afterByCoordinate.size
    && [...beforeByCoordinate.keys()].every((coordinate) => afterByCoordinate.has(coordinate));
  if (sameGeometry) {
    const changedCoordinates: number[] = [];
    const beforeIndices: number[] = [];
    const afterIndices: number[] = [];
    for (const coordinate of coordinates) {
      const previous = beforeByCoordinate.get(coordinate)?.voxel;
      const next = afterByCoordinate.get(coordinate)?.voxel;
      if (sameVoxel(previous, next) || !previous || !next) continue;
      changedCoordinates.push(coordinate);
      beforeIndices.push(previous.colorIndex);
      afterIndices.push(next.colorIndex);
    }
    return {
      kind: 'recolor',
      coordinates: Uint32Array.from(changedCoordinates),
      beforeIndices: Uint8Array.from(beforeIndices),
      afterIndices: Uint8Array.from(afterIndices),
      beforePalette: before.palette,
      afterPalette: after.palette,
      beforeSize: before.size,
      afterSize: after.size,
    };
  }
  const changes: VoxelChange[] = [];
  for (const coordinate of coordinates) {
    const previous = beforeByCoordinate.get(coordinate)?.voxel;
    const next = afterByCoordinate.get(coordinate)?.voxel;
    if (!sameVoxel(previous, next)) changes.push({ coordinate, before: previous, after: next });
  }
  return {
    kind: 'geometry',
    changes,
    beforePalette: before.palette,
    afterPalette: after.palette,
    beforeSize: before.size,
    afterSize: after.size,
  };
}

export const voxelPatchChangeCount = (patch: VoxelPatch) =>
  patch.kind === 'recolor' ? patch.coordinates.length : patch.changes.length;

const samePalette = (a: RGB[], b: RGB[]) => a === b || (a.length === b.length
  && a.every((color, index) => {
    const other = b[index];
    return Boolean(other && color.r === other.r && color.g === other.g && color.b === other.b);
  }));

const sameSize = (a: VoxelModel['size'], b: VoxelModel['size']) =>
  a === b || (a.x === b.x && a.y === b.y && a.z === b.z);

export const voxelPatchHasChanges = (patch: VoxelPatch) =>
  voxelPatchChangeCount(patch) > 0
  || !samePalette(patch.beforePalette, patch.afterPalette)
  || !sameSize(patch.beforeSize, patch.afterSize);

export function applyVoxelPatch(model: VoxelModel, patch: VoxelPatch, direction: 'undo' | 'redo'): VoxelModel {
  if (patch.kind === 'recolor') {
    const palette = direction === 'undo' ? patch.beforePalette : patch.afterPalette;
    const indices = direction === 'undo' ? patch.beforeIndices : patch.afterIndices;
    const voxelIndex = buildVoxelIndex(model.voxels);
    const voxels = [...model.voxels];
    for (let index = 0; index < patch.coordinates.length; index += 1) {
      const entry = voxelIndex.get(patch.coordinates[index]);
      const colorIndex = indices[index];
      const color = palette[colorIndex];
      if (!entry || !color) continue;
      voxels[entry.position] = { ...entry.voxel, ...color, colorIndex };
    }
    return {
      ...model,
      voxels,
      palette,
      size: direction === 'undo' ? patch.beforeSize : patch.afterSize,
    };
  }
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
