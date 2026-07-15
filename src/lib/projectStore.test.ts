import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearAutosave, loadAutosave, saveAutosave } from './projectStore';
import type { VoxelMillProject } from './projectFormat';

const project: VoxelMillProject = {
  options: {
    resolution: 8,
    paletteSize: 1,
    fillMode: 'surface',
    alphaThreshold: 0.1,
    samplingQuality: 'draft',
    materialColorMode: 'baseColor',
  },
  model: {
    sourceName: 'offline.glb',
    voxelSize: 1,
    size: { x: 1, y: 1, z: 1 },
    palette: [{ r: 1, g: 2, b: 3 }],
    voxels: [{ x: 0, y: 0, z: 0, colorIndex: 0, r: 1, g: 2, b: 3 }],
  },
};

afterEach(() => vi.unstubAllGlobals());

describe('project recovery storage', () => {
  it('degrades safely when IndexedDB is unavailable', async () => {
    vi.stubGlobal('indexedDB', undefined);
    await expect(saveAutosave(project)).resolves.toBeNull();
    await expect(loadAutosave()).resolves.toBeNull();
    await expect(clearAutosave()).resolves.toBeUndefined();
  });
});
