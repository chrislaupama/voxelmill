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

export function addVoxels(model: VoxelModel, coordinates: VoxelCoordinate[], color: RGB): VoxelModel {
  if (!coordinates.length) return model;
  const minimum = coordinates.reduce((current, coordinate) => ({
    x: Math.min(current.x, coordinate.x),
    y: Math.min(current.y, coordinate.y),
    z: Math.min(current.z, coordinate.z),
  }), { x: 0, y: 0, z: 0 });
  const shift = { x: -minimum.x, y: -minimum.y, z: -minimum.z };
  const outOfBounds = (coordinate: VoxelCoordinate) => coordinate.x < 0 || coordinate.y < 0 || coordinate.z < 0
    || coordinate.x >= 1024 || coordinate.y >= 1024 || coordinate.z >= 1024;
  if (model.voxels.some((voxel) => outOfBounds({ x: voxel.x + shift.x, y: voxel.y + shift.y, z: voxel.z + shift.z }))
    || coordinates.some((coordinate) => outOfBounds({ x: coordinate.x + shift.x, y: coordinate.y + shift.y, z: coordinate.z + shift.z }))) return model;
  const movedVoxels = shift.x || shift.y || shift.z
    ? model.voxels.map((voxel) => ({ ...voxel, x: voxel.x + shift.x, y: voxel.y + shift.y, z: voxel.z + shift.z }))
    : model.voxels;
  const voxels = new Map<number, Voxel>(movedVoxels.map((voxel) => [packVoxelCoordinate(voxel), voxel]));
  const resolved = paletteColor(model, color);
  let changed = Boolean(shift.x || shift.y || shift.z);
  for (const coordinate of coordinates) {
    const target = { x: coordinate.x + shift.x, y: coordinate.y + shift.y, z: coordinate.z + shift.z };
    const key = packVoxelCoordinate(target);
    if (voxels.has(key)) continue;
    voxels.set(key, { ...target, ...resolved.color, colorIndex: resolved.colorIndex });
    changed = true;
  }
  if (!changed) return model;
  const entries = [...voxels.values()];
  const size = entries.reduce((current, voxel) => ({
    x: Math.max(current.x, voxel.x + 1),
    y: Math.max(current.y, voxel.y + 1),
    z: Math.max(current.z, voxel.z + 1),
  }), { x: model.size.x + shift.x, y: model.size.y + shift.y, z: model.size.z + shift.z });
  return { ...model, size, palette: resolved.palette, voxels: entries };
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

export function brushCoordinates(
  center: VoxelCoordinate,
  radius: number,
  size?: VoxelModel['size'],
  shape: 'sphere' | 'cube' = 'sphere',
): VoxelCoordinate[] {
  const boundedRadius = Math.max(0, Math.min(8, Math.floor(radius)));
  const coordinates: VoxelCoordinate[] = [];
  for (let z = center.z - boundedRadius; z <= center.z + boundedRadius; z += 1) {
    for (let y = center.y - boundedRadius; y <= center.y + boundedRadius; y += 1) {
      for (let x = center.x - boundedRadius; x <= center.x + boundedRadius; x += 1) {
        if (size && (x < 0 || y < 0 || z < 0 || x >= size.x || y >= size.y || z >= size.z)) continue;
        const squaredDistance = (x - center.x) ** 2 + (y - center.y) ** 2 + (z - center.z) ** 2;
        if (shape === 'cube' || squaredDistance <= boundedRadius ** 2) coordinates.push({ x, y, z });
      }
    }
  }
  return coordinates;
}

export function paintVoxels(model: VoxelModel, coordinates: VoxelCoordinate[], color: RGB): VoxelModel {
  if (!coordinates.length) return model;
  const targets = new Set(coordinates.map(packVoxelCoordinate));
  const resolved = paletteColor(model, color);
  let changed = false;
  const voxels = model.voxels.map((voxel) => {
    if (!targets.has(packVoxelCoordinate(voxel))
      || (voxel.colorIndex === resolved.colorIndex && sameColor(voxel, resolved.color))) return voxel;
    changed = true;
    return { ...voxel, ...resolved.color, colorIndex: resolved.colorIndex };
  });
  return changed ? { ...model, palette: resolved.palette, voxels } : model;
}

export function removeVoxels(model: VoxelModel, coordinates: VoxelCoordinate[]): VoxelModel {
  if (!coordinates.length) return model;
  const targets = new Set(coordinates.map(packVoxelCoordinate));
  const voxels = model.voxels.filter((voxel) => !targets.has(packVoxelCoordinate(voxel)));
  return voxels.length === model.voxels.length ? model : { ...model, voxels };
}

export function floodFillVoxels(model: VoxelModel, start: VoxelCoordinate, color: RGB): VoxelModel {
  const index = buildVoxelIndex(model.voxels);
  const first = index.get(packVoxelCoordinate(start))?.voxel;
  if (!first) return model;
  const visited = new Set<number>();
  const queue = [first];
  const coordinates: VoxelCoordinate[] = [];
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const voxel = queue[cursor];
    const key = packVoxelCoordinate(voxel);
    if (visited.has(key) || voxel.colorIndex !== first.colorIndex) continue;
    visited.add(key);
    coordinates.push(voxel);
    const neighbors = [
      { x: voxel.x - 1, y: voxel.y, z: voxel.z }, { x: voxel.x + 1, y: voxel.y, z: voxel.z },
      { x: voxel.x, y: voxel.y - 1, z: voxel.z }, { x: voxel.x, y: voxel.y + 1, z: voxel.z },
      { x: voxel.x, y: voxel.y, z: voxel.z - 1 }, { x: voxel.x, y: voxel.y, z: voxel.z + 1 },
    ];
    for (const neighbor of neighbors) {
      if (neighbor.x < 0 || neighbor.y < 0 || neighbor.z < 0
        || neighbor.x >= model.size.x || neighbor.y >= model.size.y || neighbor.z >= model.size.z) continue;
      const candidate = index.get(packVoxelCoordinate(neighbor))?.voxel;
      if (candidate && !visited.has(packVoxelCoordinate(candidate))) queue.push(candidate);
    }
  }
  return paintVoxels(model, coordinates, color);
}

export interface VoxelTransformResult {
  model: VoxelModel;
  coordinates: VoxelCoordinate[];
}

function replaceSelectedVoxels(
  model: VoxelModel,
  selected: Set<number>,
  transformed: Voxel[],
): VoxelTransformResult {
  if (!transformed.length) return { model, coordinates: [] };
  const voxels = new Map<number, Voxel>();
  for (const voxel of model.voxels) {
    const key = packVoxelCoordinate(voxel);
    if (!selected.has(key)) voxels.set(key, voxel);
  }
  for (const voxel of transformed) voxels.set(packVoxelCoordinate(voxel), voxel);
  const size = transformed.reduce((current, voxel) => ({
    x: Math.max(current.x, voxel.x + 1),
    y: Math.max(current.y, voxel.y + 1),
    z: Math.max(current.z, voxel.z + 1),
  }), model.size);
  return { model: { ...model, size, voxels: [...voxels.values()] }, coordinates: transformed };
}

export function translateVoxels(
  model: VoxelModel,
  coordinates: VoxelCoordinate[],
  delta: VoxelCoordinate,
): VoxelTransformResult {
  const selected = new Set(coordinates.map(packVoxelCoordinate));
  const entries = model.voxels.filter((voxel) => selected.has(packVoxelCoordinate(voxel)));
  if (!entries.length || (!delta.x && !delta.y && !delta.z)) return { model, coordinates: entries };
  const transformed = entries.map((voxel) => ({ ...voxel, x: voxel.x + delta.x, y: voxel.y + delta.y, z: voxel.z + delta.z }));
  if (transformed.some((voxel) => voxel.x < 0 || voxel.y < 0 || voxel.z < 0 || voxel.x >= 1024 || voxel.y >= 1024 || voxel.z >= 1024)) {
    return { model, coordinates: entries };
  }
  return replaceSelectedVoxels(model, selected, transformed);
}

export function rotateVoxels(
  model: VoxelModel,
  coordinates: VoxelCoordinate[],
  axis: MirrorSettings['axis'],
): VoxelTransformResult {
  const selected = new Set(coordinates.map(packVoxelCoordinate));
  const entries = model.voxels.filter((voxel) => selected.has(packVoxelCoordinate(voxel)));
  if (!entries.length) return { model, coordinates: [] };
  const min = {
    x: Math.min(...entries.map((voxel) => voxel.x)),
    y: Math.min(...entries.map((voxel) => voxel.y)),
    z: Math.min(...entries.map((voxel) => voxel.z)),
  };
  const max = {
    x: Math.max(...entries.map((voxel) => voxel.x)),
    y: Math.max(...entries.map((voxel) => voxel.y)),
    z: Math.max(...entries.map((voxel) => voxel.z)),
  };
  const transformed = entries.map((voxel) => {
    if (axis === 'x') return { ...voxel, y: min.y + (voxel.z - min.z), z: min.z + (max.y - voxel.y) };
    if (axis === 'y') return { ...voxel, x: min.x + (voxel.z - min.z), z: min.z + (max.x - voxel.x) };
    return { ...voxel, x: min.x + (voxel.y - min.y), y: min.y + (max.x - voxel.x) };
  });
  if (transformed.some((voxel) => voxel.x < 0 || voxel.y < 0 || voxel.z < 0 || voxel.x >= 1024 || voxel.y >= 1024 || voxel.z >= 1024)) {
    return { model, coordinates: entries };
  }
  return replaceSelectedVoxels(model, selected, transformed);
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
