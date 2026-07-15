import { describe, expect, it } from 'vitest';
import type { VoxelMillProject } from './projectFormat';
import { decodeVoxelMillProject, encodeVoxelMillProject } from './projectFormat';

const project: VoxelMillProject = {
  options: {
    resolution: 64,
    paletteSize: 32,
    fillMode: 'solid',
    alphaThreshold: 0.1,
    samplingQuality: 'high',
    materialColorMode: 'appearance',
  },
  model: {
    sourceName: 'rocket.glb',
    voxelSize: 0.125,
    size: { x: 64, y: 32, z: 16 },
    palette: [{ r: 20, g: 30, b: 40 }, { r: 240, g: 60, b: 50 }],
    voxels: [
      { x: 1, y: 2, z: 3, colorIndex: 0, r: 20, g: 30, b: 40 },
      { x: 63, y: 31, z: 15, colorIndex: 1, r: 240, g: 60, b: 50 },
    ],
  },
};

describe('.voxelmill project format', () => {
  it('round-trips model data and conversion settings', () => {
    expect(decodeVoxelMillProject(encodeVoxelMillProject(project))).toEqual(project);
  });

  it('uses a compact seven-byte voxel record', () => {
    const one = encodeVoxelMillProject({ ...project, model: { ...project.model, voxels: [project.model.voxels[0]] } });
    const two = encodeVoxelMillProject(project);
    expect(two.byteLength - one.byteLength).toBe(7);
  });

  it('rejects wrong magic, unsupported versions, and truncated payloads', () => {
    const encoded = encodeVoxelMillProject(project);
    const wrongMagic = encoded.slice(0);
    new Uint8Array(wrongMagic)[0] = 0;
    expect(() => decodeVoxelMillProject(wrongMagic)).toThrow('not a VoxelMill');
    const wrongVersion = encoded.slice(0);
    new DataView(wrongVersion).setUint16(4, 99, true);
    expect(() => decodeVoxelMillProject(wrongVersion)).toThrow('version 99');
    expect(() => decodeVoxelMillProject(encoded.slice(0, -1))).toThrow('truncated or corrupt');
  });

  it('rejects values that would truncate or collide in the binary representation', () => {
    expect(() => encodeVoxelMillProject({
      ...project,
      model: { ...project.model, palette: [{ r: 256, g: 0, b: 0 }] },
    })).toThrow('invalid RGB');
    expect(() => encodeVoxelMillProject({
      ...project,
      model: { ...project.model, voxels: [{ ...project.model.voxels[0], x: 1.5 }] },
    })).toThrow('invalid voxel');
    expect(() => encodeVoxelMillProject({
      ...project,
      model: { ...project.model, voxels: [project.model.voxels[0], { ...project.model.voxels[0] }] },
    })).toThrow('duplicate voxel');
  });
});
