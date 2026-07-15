import type { MirrorSettings, RGB, Voxel, VoxelCoordinate, VoxelModel } from '../types';
import { nearestPaletteIndex } from './palette';
import { buildVoxelIndex, packVoxelCoordinate } from './voxelIndex';

export const voxelKey = packVoxelCoordinate;

const sameColor = (a: RGB, b: RGB) => a.r === b.r && a.g === b.g && a.b === b.b;

function paletteColor(model: VoxelModel, color: RGB) {
  const exactIndex = model.palette.findIndex((candidate) => sameColor(candidate, color));
  if (exactIndex >= 0) return { palette: model.palette, colorIndex: exactIndex, color: model.palette[exactIndex] };
  if (model.palette.length < 255) {
    return { palette: [...model.palette, color], colorIndex: model.palette.length, color };
  }
  const colorIndex = nearestPaletteIndex(color, model.palette);
  return { palette: model.palette, colorIndex, color: model.palette[colorIndex] };
}

export function addVoxel(model: VoxelModel, coordinate: VoxelCoordinate, color: RGB): VoxelModel {
  const shift = {
    x: coordinate.x < 0 ? -coordinate.x : 0,
    y: coordinate.y < 0 ? -coordinate.y : 0,
    z: coordinate.z < 0 ? -coordinate.z : 0,
  };
  const target = {
    x: coordinate.x + shift.x,
    y: coordinate.y + shift.y,
    z: coordinate.z + shift.z,
  };
  const size = {
    x: Math.max(model.size.x + shift.x, target.x + 1),
    y: Math.max(model.size.y + shift.y, target.y + 1),
    z: Math.max(model.size.z + shift.z, target.z + 1),
  };
  const movedVoxels = shift.x || shift.y || shift.z
    ? model.voxels.map((voxel) => ({ ...voxel, x: voxel.x + shift.x, y: voxel.y + shift.y, z: voxel.z + shift.z }))
    : model.voxels;
  if (buildVoxelIndex(movedVoxels).has(packVoxelCoordinate(target))) {
    return model;
  }
  const resolved = paletteColor(model, color);
  return {
    ...model,
    size,
    palette: resolved.palette,
    voxels: [...movedVoxels, { ...target, ...resolved.color, colorIndex: resolved.colorIndex }],
  };
}

export function removeVoxel(model: VoxelModel, coordinate: VoxelCoordinate): VoxelModel {
  const entry = buildVoxelIndex(model.voxels).get(packVoxelCoordinate(coordinate));
  if (!entry) return model;
  const voxels = [...model.voxels];
  voxels.splice(entry.position, 1);
  return { ...model, voxels };
}

export function paintVoxel(model: VoxelModel, coordinate: VoxelCoordinate, color: RGB): VoxelModel {
  const entry = buildVoxelIndex(model.voxels).get(packVoxelCoordinate(coordinate));
  if (!entry) return model;
  const resolved = paletteColor(model, color);
  const current = entry.voxel;
  if (current.colorIndex === resolved.colorIndex && sameColor(current, resolved.color)) return model;
  const voxels = [...model.voxels];
  voxels[entry.position] = { ...current, ...resolved.color, colorIndex: resolved.colorIndex };
  return { ...model, palette: resolved.palette, voxels };
}

const axisValue = (voxel: VoxelCoordinate, axis: MirrorSettings['axis']) => voxel[axis];

const isSourceVoxel = (voxel: VoxelCoordinate, settings: MirrorSettings) => {
  const coordinate = axisValue(voxel, settings.axis);
  return settings.direction === 'negativeToPositive' ? coordinate < settings.plane : coordinate >= settings.plane;
};

const mirroredCoordinate = (voxel: Voxel, settings: MirrorSettings): Voxel => ({
  ...voxel,
  [settings.axis]: settings.plane * 2 - 1 - axisValue(voxel, settings.axis),
});

export function buildMirrorPreview(model: VoxelModel, settings: MirrorSettings): Voxel[] {
  const limit = model.size[settings.axis];
  const preview = new Map<number, Voxel>();
  for (const voxel of model.voxels) {
    if (!isSourceVoxel(voxel, settings)) continue;
    const mirrored = mirroredCoordinate(voxel, settings);
    const coordinate = axisValue(mirrored, settings.axis);
    if (coordinate < 0 || coordinate >= limit) continue;
    preview.set(voxelKey(mirrored), mirrored);
  }
  return [...preview.values()];
}

export function mirrorModel(model: VoxelModel, settings: MirrorSettings): VoxelModel {
  const source = model.voxels.filter((voxel) => isSourceVoxel(voxel, settings));
  const preview = buildMirrorPreview(model, settings);
  const voxels = new Map<number, Voxel>();
  for (const voxel of source) voxels.set(voxelKey(voxel), voxel);
  for (const voxel of preview) voxels.set(voxelKey(voxel), voxel);
  return { ...model, voxels: [...voxels.values()] };
}
