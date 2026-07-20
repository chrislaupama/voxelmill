import type { MirrorScope, MirrorSettings, RGB, Voxel, VoxelCoordinate, VoxelModel } from '../types';
import { nearestPaletteIndex } from './palette';
import {
  buildVoxelIndex,
  isSupportedVoxelCoordinate,
  packVoxelCoordinate,
  VOXEL_COORDINATE_LIMIT,
} from './voxelIndex';

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
  if (!Number.isInteger(coordinate.x)
    || !Number.isInteger(coordinate.y)
    || !Number.isInteger(coordinate.z)) return model;
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
  if (size.x > VOXEL_COORDINATE_LIMIT
    || size.y > VOXEL_COORDINATE_LIMIT
    || size.z > VOXEL_COORDINATE_LIMIT) return model;
  const movedVoxels = shift.x || shift.y || shift.z
    ? model.voxels.map((voxel) => ({ ...voxel, x: voxel.x + shift.x, y: voxel.y + shift.y, z: voxel.z + shift.z }))
    : model.voxels;
  if (!isSupportedVoxelCoordinate(target) || movedVoxels.some((voxel) => !isSupportedVoxelCoordinate(voxel))) {
    return model;
  }
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
  const outOfBounds = (coordinate: VoxelCoordinate) => !isSupportedVoxelCoordinate(coordinate);
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
  if (size.x > VOXEL_COORDINATE_LIMIT
    || size.y > VOXEL_COORDINATE_LIMIT
    || size.z > VOXEL_COORDINATE_LIMIT) return model;
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

export function voxelLineCoordinates(
  start: VoxelCoordinate,
  end: VoxelCoordinate,
): VoxelCoordinate[] {
  const delta = {
    x: end.x - start.x,
    y: end.y - start.y,
    z: end.z - start.z,
  };
  const steps = Math.max(Math.abs(delta.x), Math.abs(delta.y), Math.abs(delta.z));
  if (steps === 0) return [{ ...start }];
  const coordinates: VoxelCoordinate[] = [];
  const visited = new Set<string>();
  for (let step = 0; step <= steps; step += 1) {
    const coordinate = {
      x: Math.round(start.x + delta.x * step / steps),
      y: Math.round(start.y + delta.y * step / steps),
      z: Math.round(start.z + delta.z * step / steps),
    };
    const key = `${coordinate.x}:${coordinate.y}:${coordinate.z}`;
    if (visited.has(key)) continue;
    visited.add(key);
    coordinates.push(coordinate);
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
    if (visited.has(key) || !sameColor(voxel, first)) continue;
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
  const min = { x: entries[0].x, y: entries[0].y, z: entries[0].z };
  const max = { ...min };
  for (let index = 1; index < entries.length; index += 1) {
    const voxel = entries[index];
    min.x = Math.min(min.x, voxel.x);
    min.y = Math.min(min.y, voxel.y);
    min.z = Math.min(min.z, voxel.z);
    max.x = Math.max(max.x, voxel.x);
    max.y = Math.max(max.y, voxel.y);
    max.z = Math.max(max.z, voxel.z);
  }
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

const rawVoxelKey = ({ x, y, z }: VoxelCoordinate) => `${x}:${y}:${z}`;

export interface MirrorPlan {
  scope: MirrorScope;
  source: Voxel[];
  additions: Voxel[];
  overwrites: Voxel[];
  removals: Voxel[];
  destinations: Voxel[];
  shift: VoxelCoordinate;
  outputSize: VoxelModel['size'];
  model: VoxelModel;
  valid: boolean;
  error: string | null;
}

/**
 * Builds a complete mirror operation without clipping destinations at the current grid bounds.
 * Preview coordinates stay in the current model's coordinate space so ghosts line up with the
 * source. The result model is normalized to non-negative coordinates and may grow its grid.
 */
export function buildMirrorPlan(
  model: VoxelModel,
  settings: MirrorSettings,
  selectedCoordinates: VoxelCoordinate[] = [],
  scope: MirrorScope = 'side',
): MirrorPlan {
  if (!Number.isSafeInteger(settings.plane)) {
    return {
      scope,
      source: [],
      additions: [],
      overwrites: [],
      removals: [],
      destinations: [],
      shift: { x: 0, y: 0, z: 0 },
      outputSize: model.size,
      model,
      valid: false,
      error: 'The mirror plane must be an integer grid boundary.',
    };
  }
  const selected = new Set(selectedCoordinates.map(packVoxelCoordinate));
  const source = scope === 'selection'
    ? model.voxels.filter((voxel) => selected.has(packVoxelCoordinate(voxel)))
    : model.voxels.filter((voxel) => isSourceVoxel(voxel, settings));
  const targetsByCoordinate = new Map<string, Voxel>();
  for (const voxel of source) {
    const target = mirroredCoordinate(voxel, settings);
    targetsByCoordinate.set(rawVoxelKey(target), target);
  }
  const targets = [...targetsByCoordinate.values()];
  const originalCoordinates = new Set(model.voxels.map(rawVoxelKey));
  const additions = targets.filter((voxel) => !originalCoordinates.has(rawVoxelKey(voxel)));
  const overwrites = targets.filter((voxel) => originalCoordinates.has(rawVoxelKey(voxel)));
  const destinationCoordinates = new Set(targets.map(rawVoxelKey));
  const retained = scope === 'selection'
    ? model.voxels
    : source;
  const removals = scope === 'side'
    ? model.voxels.filter((voxel) => !isSourceVoxel(voxel, settings) && !destinationCoordinates.has(rawVoxelKey(voxel)))
    : [];

  const minimum = targets.reduce((current, voxel) => ({
    x: Math.min(current.x, voxel.x),
    y: Math.min(current.y, voxel.y),
    z: Math.min(current.z, voxel.z),
  }), { x: 0, y: 0, z: 0 });
  const shift = {
    x: minimum.x < 0 ? -minimum.x : 0,
    y: minimum.y < 0 ? -minimum.y : 0,
    z: minimum.z < 0 ? -minimum.z : 0,
  };
  const shiftedTargets = targets.map((voxel) => ({
    ...voxel,
    x: voxel.x + shift.x,
    y: voxel.y + shift.y,
    z: voxel.z + shift.z,
  }));
  const outputSize = shiftedTargets.reduce((current, voxel) => ({
    x: Math.max(current.x, voxel.x + 1),
    y: Math.max(current.y, voxel.y + 1),
    z: Math.max(current.z, voxel.z + 1),
  }), {
    x: model.size.x + shift.x,
    y: model.size.y + shift.y,
    z: model.size.z + shift.z,
  });
  const valid = outputSize.x <= VOXEL_COORDINATE_LIMIT
    && outputSize.y <= VOXEL_COORDINATE_LIMIT
    && outputSize.z <= VOXEL_COORDINATE_LIMIT;
  const error = valid
    ? null
    : `This mirror would exceed the ${VOXEL_COORDINATE_LIMIT} voxel coordinate limit on at least one axis.`;
  if (!valid) {
    return {
      scope,
      source,
      additions,
      overwrites,
      removals,
      destinations: [],
      shift,
      outputSize,
      model,
      valid,
      error,
    };
  }

  const voxels = new Map<number, Voxel>();
  for (const voxel of retained) {
    const shifted = {
      ...voxel,
      x: voxel.x + shift.x,
      y: voxel.y + shift.y,
      z: voxel.z + shift.z,
    };
    voxels.set(packVoxelCoordinate(shifted), shifted);
  }
  for (const voxel of shiftedTargets) voxels.set(packVoxelCoordinate(voxel), voxel);
  return {
    scope,
    source,
    additions,
    overwrites,
    removals,
    destinations: shiftedTargets,
    shift,
    outputSize,
    model: { ...model, size: outputSize, voxels: [...voxels.values()] },
    valid,
    error,
  };
}

export function buildMirrorPreview(
  model: VoxelModel,
  settings: MirrorSettings,
  selectedCoordinates: VoxelCoordinate[] = [],
  scope: MirrorScope = 'side',
): Voxel[] {
  const plan = buildMirrorPlan(model, settings, selectedCoordinates, scope);
  return [...plan.additions, ...plan.overwrites];
}

export function mirrorModel(
  model: VoxelModel,
  settings: MirrorSettings,
  selectedCoordinates: VoxelCoordinate[] = [],
  scope: MirrorScope = 'side',
): VoxelModel {
  return buildMirrorPlan(model, settings, selectedCoordinates, scope).model;
}
