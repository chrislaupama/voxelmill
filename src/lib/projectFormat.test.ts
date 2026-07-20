import { describe, expect, it } from 'vitest';
import type { VoxelMillProject } from './projectFormat';
import { decodeVoxelMillProject, encodeVoxelMillProject } from './projectFormat';
import { MAX_VOXEL_COORDINATE, VOXEL_COORDINATE_LIMIT } from './voxelIndex';

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

  it('round-trips the maximum editor coordinate without truncation', () => {
    const boundary: VoxelMillProject = {
      ...project,
      options: { ...project.options, resolution: VOXEL_COORDINATE_LIMIT },
      model: {
        ...project.model,
        size: { x: VOXEL_COORDINATE_LIMIT, y: VOXEL_COORDINATE_LIMIT, z: VOXEL_COORDINATE_LIMIT },
        voxels: [{
          x: MAX_VOXEL_COORDINATE,
          y: MAX_VOXEL_COORDINATE,
          z: MAX_VOXEL_COORDINATE,
          colorIndex: 0,
          r: 20,
          g: 30,
          b: 40,
        }],
      },
    };

    expect(decodeVoxelMillProject(encodeVoxelMillProject(boundary))).toEqual(boundary);
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

  it('rejects model dimensions, options, and voxel coordinates beyond the editor limit', () => {
    expect(() => encodeVoxelMillProject({
      ...project,
      model: { ...project.model, size: { ...project.model.size, x: VOXEL_COORDINATE_LIMIT + 1 } },
    })).toThrow('manifest contains invalid values');
    expect(() => encodeVoxelMillProject({
      ...project,
      options: { ...project.options, resolution: VOXEL_COORDINATE_LIMIT + 1 },
    })).toThrow('manifest contains invalid values');
    expect(() => encodeVoxelMillProject({
      ...project,
      model: {
        ...project.model,
        size: { ...project.model.size, x: VOXEL_COORDINATE_LIMIT },
        voxels: [{ ...project.model.voxels[0], x: VOXEL_COORDINATE_LIMIT }],
      },
    })).toThrow('invalid voxel coordinate');
  });

  it('rejects non-finite alpha thresholds during encoding and decoding', () => {
    expect(() => encodeVoxelMillProject({
      ...project,
      options: { ...project.options, alphaThreshold: Number.NaN },
    })).toThrow('manifest contains invalid values');

    const encoded = encodeVoxelMillProject(project);
    const bytes = new Uint8Array(encoded);
    const view = new DataView(encoded);
    const manifestLength = view.getUint32(6, true);
    const manifest = new TextDecoder().decode(bytes.subarray(16, 16 + manifestLength));
    const invalidManifest = manifest.replace('"alphaThreshold":0.1', '"alphaThreshold":1e999');
    expect(invalidManifest).not.toBe(manifest);
    const invalidManifestBytes = new TextEncoder().encode(invalidManifest);
    const decoded = new Uint8Array(encoded.byteLength + invalidManifestBytes.byteLength - manifestLength);
    decoded.set(bytes.subarray(0, 16), 0);
    new DataView(decoded.buffer).setUint32(6, invalidManifestBytes.byteLength, true);
    decoded.set(invalidManifestBytes, 16);
    decoded.set(bytes.subarray(16 + manifestLength), 16 + invalidManifestBytes.byteLength);

    expect(() => decodeVoxelMillProject(decoded.buffer)).toThrow('manifest contains invalid values');
  });

  it('rejects an imported manifest that claims dimensions beyond the runtime contract', () => {
    const boundary = encodeVoxelMillProject({
      ...project,
      model: { ...project.model, size: { ...project.model.size, x: VOXEL_COORDINATE_LIMIT } },
    });
    const bytes = new Uint8Array(boundary);
    const manifestLength = new DataView(boundary).getUint32(6, true);
    const manifest = new TextDecoder().decode(bytes.subarray(16, 16 + manifestLength));
    const invalidManifest = manifest.replace(`"x":${VOXEL_COORDINATE_LIMIT}`, `"x":${VOXEL_COORDINATE_LIMIT + 1}`);
    expect(invalidManifest).not.toBe(manifest);
    bytes.set(new TextEncoder().encode(invalidManifest), 16);

    expect(() => decodeVoxelMillProject(boundary)).toThrow('manifest contains invalid values');
  });
});
