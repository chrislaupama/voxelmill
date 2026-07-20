import { describe, expect, it } from 'vitest';
import type { VoxelModel } from '../types';
import { compactPalette, replacePaletteColor, sortPalette } from './paletteEditing';

const model = (): VoxelModel => ({
  sourceName: 'palette.glb', voxelSize: 1, size: { x: 3, y: 1, z: 1 },
  palette: [{ r: 255, g: 255, b: 255 }, { r: 9, g: 9, b: 9 }, { r: 255, g: 0, b: 0 }],
  voxels: [
    { x: 0, y: 0, z: 0, r: 255, g: 255, b: 255, colorIndex: 0 },
    { x: 1, y: 0, z: 0, r: 255, g: 0, b: 0, colorIndex: 2 },
    { x: 2, y: 0, z: 0, r: 255, g: 0, b: 0, colorIndex: 2 },
  ],
});

describe('palette editing', () => {
  it('compacts unused entries and remaps voxel indices', () => {
    const result = compactPalette(model());
    expect(result.palette).toHaveLength(2);
    expect(result.voxels[1].colorIndex).toBe(1);
  });

  it('retains one valid swatch when compacting an empty model', () => {
    const empty = { ...model(), voxels: [] };
    const result = compactPalette(empty);

    expect(result.palette).toEqual([empty.palette[0]]);
    expect(result.voxels).toEqual([]);
  });

  it('sorts colors while preserving each voxel appearance', () => {
    const before = model();
    const result = sortPalette(before, 'luminance');
    expect(result.palette[0]).toEqual({ r: 9, g: 9, b: 9 });
    expect(result.voxels.map(({ r, g, b }) => ({ r, g, b }))).toEqual(before.voxels.map(({ r, g, b }) => ({ r, g, b })));
  });

  it('replaces a color globally and merges exact duplicates', () => {
    const replaced = replacePaletteColor(model(), 2, { r: 0, g: 120, b: 255 });
    expect(replaced.voxels.filter((voxel) => voxel.g === 120)).toHaveLength(2);
    const merged = replacePaletteColor(model(), 2, { r: 255, g: 255, b: 255 });
    expect(merged.palette).toHaveLength(2);
    expect(merged.voxels.every((voxel) => voxel.colorIndex === 0)).toBe(true);
  });
});
