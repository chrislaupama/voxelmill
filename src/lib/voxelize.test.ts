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
import type { SourceModel, VoxelizeOptions } from '../types';
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
    vi.stubGlobal('document', {
      createElement: () => ({
        width: 0,
        height: 0,
        getContext: () => ({
          drawImage: () => undefined,
          getImageData: () => ({ data: texturePixels }),
        }),
      }),
    });
    const texture = new Texture({ width: 2, height: 2 } as TexImageSource);
    texture.colorSpace = SRGBColorSpace;
    texture.flipY = false;
    const geometry = new PlaneGeometry(1, 1, 1, 1);
    const scene = new Group();
    scene.add(new Mesh(geometry, new MeshStandardMaterial({ color: '#ffffff', map: texture })));
    scene.updateMatrixWorld(true);
    const source: SourceModel = {
      scene,
      name: 'textured-plane.glb',
      bytes: 1024,
      triangles: 2,
      meshes: 1,
      materials: 1,
      textures: 1,
    };

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
});
