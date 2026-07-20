import { describe, expect, it } from 'vitest';
import type { Voxel, VoxelModel } from '../types';
import {
  addVoxel,
  addVoxels,
  brushCoordinates,
  buildMirrorPlan,
  buildMirrorPreview,
  floodFillVoxels,
  mirrorModel,
  paintVoxel,
  paintVoxels,
  removeVoxel,
  removeVoxels,
  rotateVoxels,
  translateVoxels,
  voxelLineCoordinates,
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

  it('mirrors only the explicit selection while preserving every existing voxel', () => {
    const baseModel = model();
    const settings = { axis: 'x' as const, direction: 'negativeToPositive' as const, plane: 2 };
    const plan = buildMirrorPlan(baseModel, settings, [baseModel.voxels[0]], 'selection');

    expect(plan.source).toEqual([baseModel.voxels[0]]);
    expect(plan.additions).toEqual([{ ...baseModel.voxels[0], x: 3 }]);
    expect(plan.overwrites).toHaveLength(0);
    expect(plan.removals).toHaveLength(0);
    expect(plan.model.voxels).toHaveLength(3);
    expect(plan.model.voxels.some((voxel) => voxel.x === 1 && voxel.y === 2)).toBe(true);
  });

  it('separates mirror additions, overwrites, and side removals for an honest preview', () => {
    const baseModel: VoxelModel = {
      ...model(),
      size: { x: 4, y: 2, z: 1 },
      voxels: [
        { ...model().voxels[0], x: 0, y: 0 },
        { ...model().voxels[0], x: 1, y: 0 },
        { ...model().voxels[0], x: 2, y: 1 },
        { ...model().voxels[0], x: 3, y: 0 },
        { ...model().voxels[0], x: 3, y: 1 },
      ],
    };
    const plan = buildMirrorPlan(
      baseModel,
      { axis: 'x', direction: 'negativeToPositive', plane: 2 },
    );

    expect(plan.additions.map(({ x, y }) => [x, y])).toEqual([[2, 0]]);
    expect(plan.overwrites.map(({ x, y }) => [x, y])).toEqual([[3, 0]]);
    expect(plan.removals.map(({ x, y }) => [x, y])).toEqual([[2, 1], [3, 1]]);
    expect(plan.model.voxels.map(({ x, y }) => [x, y]).sort()).toEqual([[0, 0], [1, 0], [2, 0], [3, 0]]);
  });

  it('extends positive mirror bounds instead of dropping out-of-grid destinations', () => {
    const baseModel = model();
    const plan = buildMirrorPlan(baseModel, { axis: 'x', direction: 'negativeToPositive', plane: 3 });

    expect(plan.valid).toBe(true);
    expect(plan.additions.map((voxel) => voxel.x).sort()).toEqual([4, 5]);
    expect(plan.outputSize.x).toBe(6);
    expect(plan.model.voxels.map((voxel) => voxel.x).sort()).toEqual([0, 1, 4, 5]);
  });

  it('normalizes negative mirror destinations and exposes their coordinate shift', () => {
    const baseModel = model();
    const source = { ...baseModel.voxels[0], x: 3 };
    const selectionModel = { ...baseModel, voxels: [source, baseModel.voxels[1]] };
    const plan = buildMirrorPlan(
      selectionModel,
      { axis: 'x', direction: 'positiveToNegative', plane: 1 },
      [source],
      'selection',
    );

    expect(plan.additions[0].x).toBe(-2);
    expect(plan.shift).toEqual({ x: 2, y: 0, z: 0 });
    expect(plan.outputSize.x).toBe(6);
    expect(plan.destinations[0].x).toBe(0);
    expect(plan.model.voxels.every((voxel) => voxel.x >= 0)).toBe(true);
  });

  it('rejects mirror results that cannot fit the coordinate contract', () => {
    const baseModel: VoxelModel = {
      ...model(),
      size: { x: 1024, y: 1, z: 1 },
      voxels: [{ ...model().voxels[0], x: 1023, y: 0 }],
    };
    const plan = buildMirrorPlan(
      baseModel,
      { axis: 'x', direction: 'positiveToNegative', plane: 0 },
      baseModel.voxels,
      'selection',
    );

    expect(plan.valid).toBe(false);
    expect(plan.error).toContain('1024 voxel coordinate limit');
    expect(plan.model).toBe(baseModel);
  });

  it('rejects fractional mirror planes before packing mirrored coordinates', () => {
    const baseModel = model();
    const plan = buildMirrorPlan(
      baseModel,
      { axis: 'x', direction: 'negativeToPositive', plane: 1.5 },
    );

    expect(plan.valid).toBe(false);
    expect(plan.error).toContain('integer grid boundary');
    expect(plan.destinations).toEqual([]);
    expect(plan.model).toBe(baseModel);
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

  it('rejects additions whose normalized grid would exceed the coordinate contract', () => {
    const baseModel: VoxelModel = {
      ...model(),
      size: { x: 1024, y: 3, z: 2 },
    };

    expect(addVoxels(baseModel, [{ x: -1, y: 1, z: 0 }], { r: 255, g: 0, b: 0 })).toBe(baseModel);
    expect(addVoxel(baseModel, { x: -1, y: 1, z: 0 }, { r: 255, g: 0, b: 0 })).toBe(baseModel);
    expect(addVoxel(baseModel, { x: 1.5, y: 1, z: 0 }, { r: 255, g: 0, b: 0 })).toBe(baseModel);
  });

  it('interpolates continuous brush strokes without gaps', () => {
    const line = voxelLineCoordinates({ x: 1, y: 2, z: 3 }, { x: 6, y: 4, z: 1 });
    expect(line[0]).toEqual({ x: 1, y: 2, z: 3 });
    expect(line.at(-1)).toEqual({ x: 6, y: 4, z: 1 });
    expect(new Set(line.map((coordinate) => `${coordinate.x}:${coordinate.y}:${coordinate.z}`)).size).toBe(line.length);
    for (let index = 1; index < line.length; index += 1) {
      expect(Math.max(
        Math.abs(line[index].x - line[index - 1].x),
        Math.abs(line[index].y - line[index - 1].y),
        Math.abs(line[index].z - line[index - 1].z),
      )).toBeLessThanOrEqual(1);
    }
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

  it('flood fills connected voxels with the same visible color across duplicate palette entries', () => {
    const baseModel: VoxelModel = {
      ...model(),
      size: { x: 3, y: 1, z: 1 },
      palette: [{ r: 20, g: 30, b: 40 }, { r: 20, g: 30, b: 40 }, { r: 200, g: 30, b: 40 }],
      voxels: [
        { x: 0, y: 0, z: 0, r: 20, g: 30, b: 40, colorIndex: 0 },
        { x: 1, y: 0, z: 0, r: 20, g: 30, b: 40, colorIndex: 1 },
        { x: 2, y: 0, z: 0, r: 200, g: 30, b: 40, colorIndex: 2 },
      ],
    };

    const filled = floodFillVoxels(baseModel, baseModel.voxels[0], { r: 0, g: 0, b: 255 });
    expect(filled.voxels.slice(0, 2).every((voxel) => voxel.b === 255)).toBe(true);
    expect(filled.voxels[2]).toMatchObject({ r: 200, g: 30, b: 40 });
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

  it('rotates selections larger than the JavaScript argument-spread limit', () => {
    const voxels: Voxel[] = [];
    for (let z = 0; z < 8; z += 1) {
      for (let y = 0; y < 128; y += 1) {
        for (let x = 0; x < 128; x += 1) {
          voxels.push({ x, y, z, r: 20, g: 30, b: 40, colorIndex: 0 });
        }
      }
    }
    const largeModel: VoxelModel = {
      ...model(),
      size: { x: 128, y: 128, z: 8 },
      voxels,
    };

    const rotated = rotateVoxels(largeModel, voxels, 'z');
    expect(rotated.coordinates).toHaveLength(131_072);
    expect(rotated.model.voxels).toHaveLength(131_072);
    expect(rotated.model.size).toEqual(largeModel.size);
  });
});
