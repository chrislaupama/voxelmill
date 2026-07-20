import type { MirrorAxis, Voxel, VoxelCoordinate, VoxelModel } from '../types';
import { buildVoxelIndex, packVoxelCoordinate } from './voxelIndex';

const NEIGHBOR_OFFSETS: VoxelCoordinate[] = [
  { x: -1, y: 0, z: 0 },
  { x: 1, y: 0, z: 0 },
  { x: 0, y: -1, z: 0 },
  { x: 0, y: 1, z: 0 },
  { x: 0, y: 0, z: -1 },
  { x: 0, y: 0, z: 1 },
];

const neighbor = (voxel: VoxelCoordinate, offset: VoxelCoordinate): VoxelCoordinate => ({
  x: voxel.x + offset.x,
  y: voxel.y + offset.y,
  z: voxel.z + offset.z,
});

const inBounds = (coordinate: VoxelCoordinate, size: VoxelModel['size']) =>
  coordinate.x >= 0 && coordinate.y >= 0 && coordinate.z >= 0
  && coordinate.x < size.x && coordinate.y < size.y && coordinate.z < size.z;

const sameVisibleColor = (left: Voxel, right: Voxel) =>
  left.r === right.r && left.g === right.g && left.b === right.b;

export function selectSameColor(model: VoxelModel, seed: Voxel): Set<number> {
  return new Set(model.voxels
    .filter((voxel) => sameVisibleColor(voxel, seed))
    .map(packVoxelCoordinate));
}

export function selectConnected(model: VoxelModel, seed: Voxel, sameColor = false): Set<number> {
  const index = buildVoxelIndex(model.voxels);
  const selected = new Set<number>();
  const queue = [seed];
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const voxel = queue[cursor];
    const key = packVoxelCoordinate(voxel);
    if (selected.has(key) || (sameColor && !sameVisibleColor(voxel, seed))) continue;
    selected.add(key);
    for (const offset of NEIGHBOR_OFFSETS) {
      const coordinate = neighbor(voxel, offset);
      if (!inBounds(coordinate, model.size)) continue;
      const candidate = index.get(packVoxelCoordinate(coordinate))?.voxel;
      if (candidate && !selected.has(packVoxelCoordinate(candidate))) queue.push(candidate);
    }
  }
  return selected;
}

export function invertSelection(model: VoxelModel, selection: ReadonlySet<number>): Set<number> {
  return new Set(model.voxels
    .map(packVoxelCoordinate)
    .filter((key) => !selection.has(key)));
}

export function growSelection(model: VoxelModel, selection: ReadonlySet<number>): Set<number> {
  const index = buildVoxelIndex(model.voxels);
  const grown = new Set(selection);
  for (const key of selection) {
    const entry = index.get(key);
    if (!entry) continue;
    for (const offset of NEIGHBOR_OFFSETS) {
      const coordinate = neighbor(entry.voxel, offset);
      if (!inBounds(coordinate, model.size)) continue;
      if (index.has(packVoxelCoordinate(coordinate))) grown.add(packVoxelCoordinate(coordinate));
    }
  }
  return grown;
}

export function shrinkSelection(model: VoxelModel, selection: ReadonlySet<number>): Set<number> {
  const index = buildVoxelIndex(model.voxels);
  const shrunk = new Set<number>();
  for (const key of selection) {
    const entry = index.get(key);
    if (!entry) continue;
    const surrounded = NEIGHBOR_OFFSETS.every((offset) => {
      const coordinate = neighbor(entry.voxel, offset);
      if (!inBounds(coordinate, model.size)) return false;
      const candidate = index.get(packVoxelCoordinate(coordinate));
      return Boolean(candidate && selection.has(packVoxelCoordinate(candidate.voxel)));
    });
    if (surrounded) shrunk.add(key);
  }
  return shrunk;
}

export function selectSlice(model: VoxelModel, axis: MirrorAxis, index: number): Set<number> {
  return new Set(model.voxels
    .filter((voxel) => voxel[axis] === index)
    .map(packVoxelCoordinate));
}
