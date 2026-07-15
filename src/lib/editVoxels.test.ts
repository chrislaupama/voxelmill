import { describe, expect, it } from 'vitest';
import type { VoxelModel } from '../types';
import {
  addVoxel,
  addVoxels,
  brushCoordinates,
  buildMirrorPreview,
  floodFillVoxels,
  mirrorModel,
  paintVoxel,
  paintVoxels,
  removeVoxel,
  removeVoxels,
  rotateVoxels,
  translateVoxels,
} from './editVoxels';

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

  it('builds bounded sphere and cube brushes and applies them atomically', () => {
    const baseModel = model();
    const sphere = brushCoordinates({ x: 1, y: 1, z: 1 }, 1, { x: 3, y: 3, z: 3 });
    const cube = brushCoordinates({ x: 0, y: 0, z: 0 }, 1, { x: 3, y: 3, z: 3 }, 'cube');
    expect(sphere).toHaveLength(7);
    expect(cube).toHaveLength(8);
    const painted = paintVoxels(baseModel, baseModel.voxels, { r: 0, g: 255, b: 0 });
    expect(painted.voxels.every((voxel) => voxel.g === 255)).toBe(true);
    expect(removeVoxels(painted, [painted.voxels[0]]).voxels).toHaveLength(1);
    const expanded = addVoxels(baseModel, brushCoordinates({ x: -1, y: 1, z: 0 }, 1), { r: 255, g: 0, b: 0 });
    expect(expanded.size.x).toBe(6);
    expect(expanded.voxels.some((voxel) => voxel.x === 0 && voxel.r === 255)).toBe(true);
  });

  it('flood fills only the connected component with the starting color', () => {
    const baseModel = model();
    const fillModel = {
      ...baseModel,
      size: { x: 4, y: 1, z: 1 },
      voxels: [
        { ...baseModel.voxels[0], y: 0 },
        { ...baseModel.voxels[0], x: 1, y: 0 },
        { ...baseModel.voxels[0], x: 3, y: 0 },
      ],
    };
    const filled = floodFillVoxels(fillModel, { x: 0, y: 0, z: 0 }, { r: 0, g: 0, b: 255 });
    expect(filled.voxels.filter((voxel) => voxel.b === 255)).toHaveLength(2);
    expect(filled.voxels.find((voxel) => voxel.x === 3)).toMatchObject({ r: 20, g: 30, b: 40 });
  });

  it('translates and rotates a selection while replacing destination collisions', () => {
    const baseModel = model();
    const translated = translateVoxels(baseModel, [baseModel.voxels[0]], { x: 1, y: 1, z: 1 });
    expect(translated.coordinates).toEqual([{ ...baseModel.voxels[0], x: 1, y: 2, z: 1 }]);
    expect(translated.model.voxels).toHaveLength(1);
    expect(translated.model.size.y).toBe(3);

    const vertical = {
      ...baseModel,
      size: { x: 2, y: 2, z: 1 },
      voxels: [{ ...baseModel.voxels[0], y: 0 }, { ...baseModel.voxels[1], x: 0, y: 1, z: 0 }],
    };
    const rotated = rotateVoxels(vertical, vertical.voxels, 'z');
    expect(rotated.coordinates.map(({ x, y }) => [x, y]).sort()).toEqual([[0, 0], [1, 0]]);
  });
});
