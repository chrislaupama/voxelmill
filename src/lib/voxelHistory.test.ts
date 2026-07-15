import { describe, expect, it } from 'vitest';
import type { VoxelModel } from '../types';
import { paintVoxel, removeVoxel } from './editVoxels';
import { applyVoxelPatch, createVoxelPatch } from './voxelHistory';

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
    expect(patch.changes).toHaveLength(1);
    expect(applyVoxelPatch(painted, patch, 'undo')).toEqual(model);
    expect(applyVoxelPatch(model, patch, 'redo')).toEqual(painted);
  });

  it('restores deletions without retaining an entire model snapshot', () => {
    const removed = removeVoxel(model, model.voxels[0]);
    const patch = createVoxelPatch(model, removed);
    expect(patch.changes).toHaveLength(1);
    expect(applyVoxelPatch(removed, patch, 'undo').voxels).toHaveLength(2);
    expect(applyVoxelPatch(model, patch, 'redo').voxels).toEqual(removed.voxels);
  });
});
