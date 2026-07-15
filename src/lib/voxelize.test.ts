import {
  BoxGeometry,
  BufferAttribute,
  Group,
  Mesh,
  MeshStandardMaterial,
  PlaneGeometry,
  SRGBColorSpace,
  Texture,
} from 'three';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import qualityThresholds from '../../quality/conversion-thresholds.json';
import type { SourceModel, VoxelizeOptions } from '../types';
import { compareVoxelColors, measurePaletteError } from './quality';
import { voxelizeModel } from './voxelize';

const makeSource = (): SourceModel => {
  const scene = new Group();
  scene.add(new Mesh(new BoxGeometry(1, 1, 1), new MeshStandardMaterial({ color: '#dc642f' })));
  scene.updateMatrixWorld(true);
  return {
    scene,
    name: 'cube.glb',
    bytes: 1024,
    triangles: 12,
    meshes: 1,
    materials: 1,
    textures: 0,
  };
};

const baseOptions: VoxelizeOptions = {
  resolution: 8,
  paletteSize: 4,
  fillMode: 'surface',
  alphaThreshold: 0.1,
};

function makeTexture(data: Uint8ClampedArray, width: number, height: number) {
  vi.stubGlobal('document', {
    createElement: () => ({
      width: 0,
      height: 0,
      getContext: () => ({
        drawImage: () => undefined,
        getImageData: () => ({ data }),
      }),
    }),
  });
  const texture = new Texture({ width, height } as TexImageSource);
  texture.colorSpace = SRGBColorSpace;
  texture.flipY = false;
  return texture;
}

function makeTexturedPlane(texture: Texture): SourceModel {
  const scene = new Group();
  scene.add(new Mesh(new PlaneGeometry(1, 1, 1, 1), new MeshStandardMaterial({ color: '#ffffff', map: texture })));
  scene.updateMatrixWorld(true);
  return {
    scene,
    name: 'textured-plane.glb',
    bytes: 1024,
    triangles: 2,
    meshes: 1,
    materials: 1,
    textures: 1,
  };
}

beforeAll(() => {
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  });
});

describe('voxelizeModel', () => {
  it('voxelizes mesh triangles and retains the material color', async () => {
    const result = await voxelizeModel(makeSource(), baseOptions, () => undefined);
    expect(result.voxels.length).toBeGreaterThan(100);
    expect(result.palette.length).toBeLessThanOrEqual(4);
    expect(Math.max(result.size.x, result.size.y, result.size.z)).toBe(10);
    expect(result.voxels[0].r).toBeGreaterThan(result.voxels[0].b);
  });

  it('produces more cells when solid filling a closed mesh', async () => {
    const surface = await voxelizeModel(makeSource(), baseOptions, () => undefined);
    const solid = await voxelizeModel(makeSource(), { ...baseOptions, fillMode: 'solid' }, () => undefined);
    expect(solid.voxels.length).toBeGreaterThan(surface.voxels.length);
  });

  it('samples GLB vertex colors into the voxel palette', async () => {
    const source = makeSource();
    const mesh = source.scene.children[0] as Mesh;
    const positions = mesh.geometry.attributes.position;
    const colors = new Float32Array(positions.count * 3);
    for (let index = 0; index < positions.count; index += 1) {
      const redFace = Math.floor(index / 4) % 2 === 0;
      colors[index * 3] = redFace ? 1 : 0;
      colors[index * 3 + 1] = 0;
      colors[index * 3 + 2] = redFace ? 0 : 1;
    }
    mesh.geometry.setAttribute('color', new BufferAttribute(colors, 3));
    (mesh.material as MeshStandardMaterial).vertexColors = true;

    const result = await voxelizeModel(source, { ...baseOptions, paletteSize: 8 }, () => undefined);
    const containsRed = result.palette.some((color) => color.r > color.b);
    const containsBlue = result.palette.some((color) => color.b > color.r);
    expect(containsRed).toBe(true);
    expect(containsBlue).toBe(true);
  });

  it('preserves distinct embedded texture regions through palette generation', async () => {
    const texturePixels = new Uint8ClampedArray([
      255, 0, 0, 255, 255, 0, 0, 255,
      0, 0, 255, 255, 0, 0, 255, 255,
    ]);
    const source = makeTexturedPlane(makeTexture(texturePixels, 2, 2));

    const result = await voxelizeModel(source, { ...baseOptions, paletteSize: 8 }, () => undefined);
    expect(result.palette.some((color) => color.r > color.b * 1.5)).toBe(true);
    expect(result.palette.some((color) => color.b > color.r * 1.5)).toBe(true);
    const midpoint = result.size.y / 2;
    const bottom = result.voxels.filter((voxel) => voxel.y < midpoint);
    const top = result.voxels.filter((voxel) => voxel.y >= midpoint);
    const average = (voxels: typeof result.voxels, channel: 'r' | 'b') =>
      voxels.reduce((sum, voxel) => sum + voxel[channel], 0) / voxels.length;
    // glTF flipY=false maps UV v=0 to the decoded image's top row. This is the
    // convention that previously caused unrelated atlas regions to be sampled.
    expect(average(bottom, 'r')).toBeGreaterThan(average(bottom, 'b'));
    expect(average(top, 'b')).toBeGreaterThan(average(top, 'r'));
  });

  it('keeps ordered texture bands spatially coherent instead of producing palette noise', async () => {
    const bands = [
      { r: 239, g: 45, b: 53 },
      { r: 40, g: 199, b: 82 },
      { r: 45, g: 85, b: 235 },
      { r: 244, g: 195, b: 44 },
    ];
    const pixels = new Uint8ClampedArray(8 * 2 * 4);
    for (let y = 0; y < 2; y += 1) {
      for (let x = 0; x < 8; x += 1) {
        const color = bands[Math.floor(x / 2)];
        const offset = (y * 8 + x) * 4;
        pixels.set([color.r, color.g, color.b, 255], offset);
      }
    }
    const result = await voxelizeModel(
      makeTexturedPlane(makeTexture(pixels, 8, 2)),
      { ...baseOptions, resolution: 32, paletteSize: 4 },
      () => undefined,
    );
    const minX = Math.min(...result.voxels.map((voxel) => voxel.x));
    const maxX = Math.max(...result.voxels.map((voxel) => voxel.x));
    const occupiedWidth = maxX - minX + 1;
    const reference = result.voxels.map((voxel) => {
      const u = (voxel.x - minX + 0.5) / occupiedWidth;
      const color = bands[Math.min(bands.length - 1, Math.floor(u * bands.length))];
      return { ...voxel, ...color };
    });
    const metrics = compareVoxelColors(result.voxels, reference);
    const paletteMetrics = measurePaletteError(bands, result.palette);
    expect(metrics.coverage).toBe(1);
    expect(metrics.mean).toBeLessThan(qualityThresholds.syntheticTextureBands.spatialMeanOklabMaximum);
    expect(metrics.p95).toBeLessThan(qualityThresholds.syntheticTextureBands.spatialP95OklabMaximum);
    expect(paletteMetrics.max).toBeLessThan(qualityThresholds.syntheticTextureBands.paletteMaximumOklabError);
  });

  it('uses the texture-selected alternate UV channel', async () => {
    const pixels = new Uint8ClampedArray([
      255, 0, 0, 255, 255, 0, 0, 255,
      0, 0, 255, 255, 0, 0, 255, 255,
    ]);
    const texture = makeTexture(pixels, 2, 2);
    texture.channel = 1;
    const source = makeTexturedPlane(texture);
    const mesh = source.scene.children[0] as Mesh;
    const count = mesh.geometry.attributes.position.count;
    const uv1 = new Float32Array(count * 2);
    for (let index = 0; index < count; index += 1) {
      uv1[index * 2] = 0.5;
      uv1[index * 2 + 1] = 0;
    }
    mesh.geometry.setAttribute('uv1', new BufferAttribute(uv1, 2));

    const result = await voxelizeModel(source, { ...baseOptions, paletteSize: 4 }, () => undefined);
    expect(result.voxels.every((voxel) => voxel.r > voxel.b * 2)).toBe(true);
  });

  it('rejects fully transparent texture samples at the configured alpha threshold', async () => {
    const transparent = new Uint8ClampedArray([
      255, 0, 0, 0, 255, 0, 0, 0,
      255, 0, 0, 0, 255, 0, 0, 0,
    ]);
    await expect(voxelizeModel(
      makeTexturedPlane(makeTexture(transparent, 2, 2)),
      { ...baseOptions, alphaThreshold: 0.1 },
      () => undefined,
    )).rejects.toThrow('No opaque voxel cells were produced');
  });
});
