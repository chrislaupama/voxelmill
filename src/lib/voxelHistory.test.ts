import { describe, expect, it } from 'vitest';
import type { VoxelModel } from '../types';
import { paintVoxel, removeVoxel } from './editVoxels';
import {
  applyVoxelPatch,
  createVoxelPatch,
  voxelPatchChangeCount,
  voxelPatchHasChanges,
} from './voxelHistory';

const model: VoxelModel = {
  voxels: [
    { x: 0, y: 0, z: 0, r: 255, g: 0, b: 0, colorIndex: 0 },
    { x: 1, y: 0, z: 0, r: 255, g: 0, b: 0, colorIndex: 0 },
  ],
  palette: [{ r: 255, g: 0, b: 0 }],
  size: { x: 2, y: 1, z: 1 },
  voxelSize: 1,
  sourceName: 'history.glb',
};

describe('voxel diff history', () => {
  it('stores a one-voxel paint as a one-coordinate patch', () => {
    const painted = paintVoxel(model, model.voxels[1], { r: 0, g: 0, b: 255 });
    const patch = createVoxelPatch(model, painted);
    expect(patch.kind).toBe('recolor');
    expect(voxelPatchChangeCount(patch)).toBe(1);
    expect(applyVoxelPatch(painted, patch, 'undo')).toEqual(model);
    expect(applyVoxelPatch(model, patch, 'redo')).toEqual(painted);
  });

  it('restores deletions without retaining an entire model snapshot', () => {
    const removed = removeVoxel(model, model.voxels[0]);
    const patch = createVoxelPatch(model, removed);
    expect(patch.kind).toBe('geometry');
    expect(voxelPatchChangeCount(patch)).toBe(1);
    expect(applyVoxelPatch(removed, patch, 'undo').voxels).toHaveLength(2);
    expect(applyVoxelPatch(model, patch, 'redo').voxels).toEqual(removed.voxels);
  });

  it('stores large palette edits as compact index arrays', () => {
    const large: VoxelModel = {
      ...model,
      size: { x: 100, y: 100, z: 1 },
      voxels: Array.from({ length: 10_000 }, (_, index) => ({ x: index % 100, y: Math.floor(index / 100), z: 0, r: 255, g: 0, b: 0, colorIndex: 0 })),
    };
    const recolored: VoxelModel = {
      ...large,
      palette: [{ r: 10, g: 20, b: 30 }],
      voxels: large.voxels.map((voxel) => ({ ...voxel, r: 10, g: 20, b: 30 })),
    };
    const patch = createVoxelPatch(large, recolored);
    expect(patch.kind).toBe('recolor');
    if (patch.kind !== 'recolor') throw new Error('Expected a recolor patch.');
    expect(patch.coordinates).toBeInstanceOf(Uint32Array);
    expect(patch.beforeIndices).toBeInstanceOf(Uint8Array);
    expect(patch.coordinates).toHaveLength(10_000);
    expect(applyVoxelPatch(recolored, patch, 'undo')).toEqual(large);
  });

  it('records and restores palette-only edits with no coordinate payload', () => {
    const withUnusedSwatch: VoxelModel = {
      ...model,
      palette: [model.palette[0], { r: 0, g: 0, b: 255 }],
    };
    const patch = createVoxelPatch(withUnusedSwatch, model);

    expect(patch.kind).toBe('recolor');
    expect(voxelPatchChangeCount(patch)).toBe(0);
    expect(voxelPatchHasChanges(patch)).toBe(true);
    expect(applyVoxelPatch(model, patch, 'undo')).toEqual(withUnusedSwatch);
    expect(applyVoxelPatch(withUnusedSwatch, patch, 'redo')).toEqual(model);
  });

  it('detects size-only changes and ignores structurally equal models', () => {
    const resized: VoxelModel = { ...model, size: { x: 3, y: 1, z: 1 } };
    const resizePatch = createVoxelPatch(model, resized);
    const noOpPatch = createVoxelPatch(model, {
      ...model,
      palette: model.palette.map((color) => ({ ...color })),
      size: { ...model.size },
    });

    expect(voxelPatchChangeCount(resizePatch)).toBe(0);
    expect(voxelPatchHasChanges(resizePatch)).toBe(true);
    expect(applyVoxelPatch(resized, resizePatch, 'undo')).toEqual(model);
    expect(applyVoxelPatch(model, resizePatch, 'redo')).toEqual(resized);
    expect(voxelPatchHasChanges(noOpPatch)).toBe(false);
  });
});
