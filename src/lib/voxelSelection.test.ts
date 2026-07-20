import { describe, expect, it } from 'vitest';
import type { Voxel, VoxelModel } from '../types';
import { packVoxelCoordinate } from './voxelIndex';
import {
  growSelection,
  invertSelection,
  selectConnected,
  selectSameColor,
  selectSlice,
  shrinkSelection,
} from './voxelSelection';

const voxel = (x: number, y: number, z: number, colorIndex = 0): Voxel => ({
  x, y, z, colorIndex,
  r: colorIndex ? 220 : 20,
  g: colorIndex ? 40 : 30,
  b: colorIndex ? 30 : 40,
});

const model = (): VoxelModel => ({
  sourceName: 'selection.glb',
  voxelSize: 1,
  size: { x: 5, y: 3, z: 3 },
  palette: [{ r: 20, g: 30, b: 40 }, { r: 220, g: 40, b: 30 }],
  voxels: [
    voxel(0, 1, 1), voxel(1, 1, 1), voxel(2, 1, 1, 1),
    voxel(4, 1, 1, 1), voxel(1, 0, 1), voxel(1, 2, 1),
    voxel(1, 1, 0), voxel(1, 1, 2),
  ],
});

describe('voxel selections', () => {
  it('selects connected geometry with an optional color boundary', () => {
    const base = model();
    expect(selectConnected(base, base.voxels[0])).toHaveLength(7);
    expect(selectConnected(base, base.voxels[0], true)).toHaveLength(6);
    expect(selectSameColor(base, base.voxels[2])).toHaveLength(2);
  });

  it('treats duplicate palette entries with the same RGB as one visible color', () => {
    const base = model();
    base.palette.push({ ...base.palette[0] });
    base.voxels[1] = { ...base.voxels[1], colorIndex: 2 };

    expect(selectConnected(base, base.voxels[0], true)).toHaveLength(6);
    expect(selectSameColor(base, base.voxels[0])).toHaveLength(6);
  });

  it('grows, shrinks, and inverts selections using occupied neighbors', () => {
    const base = model();
    const center = new Set([packVoxelCoordinate(base.voxels[1])]);
    const grown = growSelection(base, center);
    expect(grown).toHaveLength(7);
    expect(shrinkSelection(base, grown)).toEqual(center);
    expect(invertSelection(base, center)).toHaveLength(base.voxels.length - 1);
  });

  it('selects only occupied voxels on a requested slice', () => {
    const base = model();
    expect(selectSlice(base, 'x', 1)).toHaveLength(5);
    expect(selectSlice(base, 'x', 3)).toHaveLength(0);
  });
});
