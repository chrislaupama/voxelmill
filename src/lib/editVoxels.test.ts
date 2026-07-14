import { describe, expect, it } from 'vitest';
import type { VoxelModel } from '../types';
import { addVoxel, buildMirrorPreview, mirrorModel, paintVoxel, removeVoxel } from './editVoxels';

const model = (): VoxelModel => ({
  sourceName: 'edit.glb',
  voxelSize: 1,
  size: { x: 4, y: 3, z: 2 },
  palette: [{ r: 20, g: 30, b: 40 }],
  voxels: [
    { x: 0, y: 1, z: 0, r: 20, g: 30, b: 40, colorIndex: 0 },
    { x: 1, y: 2, z: 1, r: 20, g: 30, b: 40, colorIndex: 0 },
  ],
});

describe('voxel editing', () => {
  it('adds voxels and expands the grid past its boundary', () => {
    const result = addVoxel(model(), { x: -1, y: 1, z: 0 }, { r: 200, g: 40, b: 30 });
    expect(result.size.x).toBe(5);
    expect(result.voxels).toHaveLength(3);
    expect(result.voxels.some((voxel) => voxel.x === 0 && voxel.colorIndex === 1)).toBe(true);
    expect(result.voxels.some((voxel) => voxel.x === 1 && voxel.colorIndex === 0)).toBe(true);
  });

  it('removes and paints individual voxels with custom palette colors', () => {
    const painted = paintVoxel(model(), { x: 1, y: 2, z: 1 }, { r: 8, g: 220, b: 90 });
    expect(painted.palette).toHaveLength(2);
    expect(painted.voxels[1]).toMatchObject({ r: 8, g: 220, b: 90, colorIndex: 1 });
    expect(removeVoxel(painted, { x: 0, y: 1, z: 0 }).voxels).toHaveLength(1);
  });

  it('previews and applies a directional mirror across a chosen plane', () => {
    const settings = { axis: 'x' as const, direction: 'negativeToPositive' as const, plane: 2 };
    const preview = buildMirrorPreview(model(), settings);
    expect(preview.map((voxel) => voxel.x).sort()).toEqual([2, 3]);
    const mirrored = mirrorModel(model(), settings);
    expect(mirrored.voxels.map((voxel) => voxel.x).sort()).toEqual([0, 1, 2, 3]);
  });
});
