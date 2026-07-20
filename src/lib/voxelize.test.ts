import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  Group,
  InstancedMesh,
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
import { stabilizeSurfacePaletteIndices, voxelizeModel } from './voxelize';

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
  samplingQuality: 'balanced',
  materialColorMode: 'baseColor',
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

function sortedPalette(palette: Array<{ r: number; g: number; b: number }>) {
  return palette
    .map((color) => `${color.r},${color.g},${color.b}`)
    .sort();
}

function surfaceLayer(width: number, height: number, colorIndex = 0) {
  return {
    state: new Uint8Array(width * height).fill(1),
    colors: new Uint16Array(width * height).fill(colorIndex),
  };
}

const layerIndex = (x: number, y: number, width: number) => x + width * y;

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

  it('builds a solid model palette from surface cells so interior volume cannot displace surface accents', async () => {
    const scene = new Group();
    const materials = ['#e82d3f', '#2646d9', '#31bb62', '#f0c534', '#ed772e', '#a142c4']
      .map((color) => new MeshStandardMaterial({ color }));
    scene.add(new Mesh(new BoxGeometry(1, 1, 1), materials));
    scene.updateMatrixWorld(true);
    const source: SourceModel = {
      scene,
      name: 'surface-accent-cube.glb',
      bytes: 1024,
      triangles: 12,
      meshes: 1,
      materials: materials.length,
      textures: 0,
    };
    const options = { ...baseOptions, resolution: 8, paletteSize: 3 };

    const surface = await voxelizeModel(source, { ...options, fillMode: 'surface' }, () => undefined);
    const solid = await voxelizeModel(source, { ...options, fillMode: 'solid' }, () => undefined);

    expect(solid.voxels.length).toBeGreaterThan(surface.voxels.length);
    expect(sortedPalette(solid.palette)).toEqual(sortedPalette(surface.palette));
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

  it('interpolates sRGB texture samples in linear light', async () => {
    const pixels = new Uint8ClampedArray([
      0, 0, 0, 255,
      255, 255, 255, 255,
    ]);
    const source = makeTexturedPlane(makeTexture(pixels, 2, 1));
    const mesh = source.scene.children[0] as Mesh;
    const uv = mesh.geometry.attributes.uv as BufferAttribute;
    for (let index = 0; index < uv.count; index += 1) {
      uv.setXY(index, 0.5, 0.5);
    }

    const result = await voxelizeModel(source, { ...baseOptions, paletteSize: 1 }, () => undefined);

    // A 50/50 blend of black and white is about 188 in sRGB when averaged in
    // linear light. Averaging encoded values would incorrectly produce 128.
    expect(result.palette[0].r).toBeGreaterThanOrEqual(184);
    expect(result.palette[0].r).toBeLessThanOrEqual(192);
    expect(result.palette[0].g).toBe(result.palette[0].r);
    expect(result.palette[0].b).toBe(result.palette[0].r);
  });

  it('keeps one- and two-byte sRGB texture channels dark', async () => {
    const pixels = new Uint8ClampedArray([1, 2, 1, 255]);
    const result = await voxelizeModel(
      makeTexturedPlane(makeTexture(pixels, 1, 1)),
      { ...baseOptions, paletteSize: 1 },
      () => undefined,
    );

    // Byte values 1 and 2 must be normalized as 1/255 and 2/255 before the
    // sRGB transfer function. Treating values <= 1 as already normalized made
    // channel value 1 decode as full intensity and created bright color noise.
    expect(Math.max(result.palette[0].r, result.palette[0].g, result.palette[0].b)).toBeLessThanOrEqual(3);
    expect(Math.min(result.palette[0].r, result.palette[0].g, result.palette[0].b)).toBeGreaterThanOrEqual(1);
  });

  it('uses only in-cell fallback probes when the center projection leaves the voxel', async () => {
    const pixels = new Uint8ClampedArray(8 * 4);
    pixels.set([0, 0, 255, 255], 0);
    for (let pixel = 1; pixel < 8; pixel += 1) {
      pixels.set([255, 0, 0, 255], pixel * 4);
    }
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(new Float32Array([
      -1, -1, 0,
      -1, -1, 0.5,
      0.1, 1, 0,
    ]), 3));
    // The small part inside target cell (2,2,1) is near u=0 (blue), while
    // projecting that cell's center onto the triangle lands outside the cell at
    // u>1/7 (red). The invalid center must never vote for the cell's color.
    geometry.setAttribute('uv', new BufferAttribute(new Float32Array([
      1, 0,
      1, 0,
      0, 0,
    ]), 2));
    const scene = new Group();
    scene.add(new Mesh(
      geometry,
      new MeshStandardMaterial({ color: '#ffffff', map: makeTexture(pixels, 8, 1) }),
    ));
    scene.updateMatrixWorld(true);
    const source: SourceModel = {
      scene,
      name: 'cell-local-texture-sample.glb',
      bytes: 1024,
      triangles: 1,
      meshes: 1,
      materials: 1,
      textures: 1,
    };

    const result = await voxelizeModel(
      source,
      { ...baseOptions, resolution: 2, paletteSize: 16, samplingQuality: 'draft' },
      () => undefined,
    );
    const target = result.voxels.find((voxel) => voxel.x === 2 && voxel.y === 2 && voxel.z === 1);

    expect(target).toBeDefined();
    expect(target!.b).toBeGreaterThan(target!.r);
  });

  it('does not dilate triangles onto the positive side of an exact grid boundary', async () => {
    const result = await voxelizeModel(
      makeTexturedPlane(makeTexture(new Uint8ClampedArray([255, 255, 255, 255]), 1, 1)),
      { ...baseOptions, resolution: 8, paletteSize: 1, samplingQuality: 'draft' },
      () => undefined,
    );
    const occupiedX = new Set(result.voxels.map((voxel) => voxel.x));
    const occupiedY = new Set(result.voxels.map((voxel) => voxel.y));

    expect(occupiedX.size).toBe(8);
    expect(occupiedY.size).toBe(8);
  });

  it('voxelizes the active morph-target pose and uses its precise bounds', async () => {
    const geometry = new PlaneGeometry(1, 1, 1, 1);
    const basePosition = geometry.attributes.position as BufferAttribute;
    const morphed = new Float32Array(basePosition.count * 3);
    for (let index = 0; index < basePosition.count; index += 1) {
      morphed[index * 3] = basePosition.getX(index) + 2;
      morphed[index * 3 + 1] = basePosition.getY(index);
      morphed[index * 3 + 2] = basePosition.getZ(index);
    }
    geometry.morphAttributes.position = [new BufferAttribute(morphed, 3)];
    geometry.morphTargetsRelative = false;
    const mesh = new Mesh(geometry, new MeshStandardMaterial({ color: '#ffffff' }));
    mesh.updateMorphTargets();
    mesh.morphTargetInfluences![0] = 1;
    const scene = new Group();
    scene.add(mesh);
    scene.updateMatrixWorld(true);
    const source: SourceModel = {
      scene,
      name: 'morphed-plane.glb',
      bytes: 1024,
      triangles: 2,
      meshes: 1,
      materials: 1,
      textures: 0,
    };

    const result = await voxelizeModel(source, baseOptions, () => undefined);

    expect(result.voxelSize).toBeCloseTo(1 / baseOptions.resolution, 8);
    expect(new Set(result.voxels.map((voxel) => voxel.x)).size).toBe(baseOptions.resolution);
  });

  it('rejects instanced meshes instead of silently voxelizing only the base geometry', async () => {
    const scene = new Group();
    scene.add(new InstancedMesh(
      new BoxGeometry(1, 1, 1),
      new MeshStandardMaterial({ color: '#ffffff' }),
      2,
    ));
    scene.updateMatrixWorld(true);
    const source: SourceModel = {
      scene,
      name: 'instances.glb',
      bytes: 1024,
      triangles: 24,
      meshes: 1,
      materials: 1,
      textures: 0,
    };

    await expect(voxelizeModel(source, baseOptions, () => undefined))
      .rejects.toThrow('Instanced meshes are not supported yet');
  });

  it('averages overlapping triangle contributions in linear light', async () => {
    const scene = new Group();
    const geometry = new PlaneGeometry(1, 1, 1, 1);
    scene.add(new Mesh(geometry, new MeshStandardMaterial({ color: '#000000' })));
    scene.add(new Mesh(geometry.clone(), new MeshStandardMaterial({ color: '#ffffff' })));
    scene.updateMatrixWorld(true);
    const source: SourceModel = {
      scene,
      name: 'overlapping-planes.glb',
      bytes: 1024,
      triangles: 4,
      meshes: 2,
      materials: 2,
      textures: 0,
    };

    const result = await voxelizeModel(source, { ...baseOptions, paletteSize: 1 }, () => undefined);

    expect(result.palette[0].r).toBeGreaterThanOrEqual(184);
    expect(result.palette[0].r).toBeLessThanOrEqual(192);
    expect(result.palette[0].g).toBe(result.palette[0].r);
    expect(result.palette[0].b).toBe(result.palette[0].r);
  });

  it('weights overlapping surfaces by area instead of triangle count', async () => {
    const scene = new Group();
    scene.add(new Mesh(
      new PlaneGeometry(1, 1, 1, 1),
      new MeshStandardMaterial({ color: '#000000' }),
    ));
    scene.add(new Mesh(
      new PlaneGeometry(1, 1, 8, 8),
      new MeshStandardMaterial({ color: '#ffffff' }),
    ));
    scene.updateMatrixWorld(true);
    const source: SourceModel = {
      scene,
      name: 'mixed-tessellation-planes.glb',
      bytes: 1024,
      triangles: 130,
      meshes: 2,
      materials: 2,
      textures: 0,
    };

    const result = await voxelizeModel(source, { ...baseOptions, paletteSize: 1 }, () => undefined);

    // Equal-area black and white surfaces should stay close to their linear-light
    // midpoint even when the white surface contains 64x as many triangles.
    expect(result.palette[0].r).toBeGreaterThanOrEqual(165);
    expect(result.palette[0].r).toBeLessThanOrEqual(210);
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
      // The source uses linear texture filtering, so compare against the band
      // belonging to the nearest source texel rather than idealized quarter-UV
      // boundaries that do not match the eight-texel sampling lattice.
      const sourceTexel = Math.round(u * 7);
      const color = bands[Math.min(bands.length - 1, Math.floor(sourceTexel / 2))];
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

  it('rejects fully transparent BLEND texture samples at the configured alpha threshold', async () => {
    const transparent = new Uint8ClampedArray([
      255, 0, 0, 0, 255, 0, 0, 0,
      255, 0, 0, 0, 255, 0, 0, 0,
    ]);
    const source = makeTexturedPlane(makeTexture(transparent, 2, 2));
    const mesh = source.scene.children[0] as Mesh;
    (mesh.material as MeshStandardMaterial).transparent = true;
    await expect(voxelizeModel(
      source,
      { ...baseOptions, alphaThreshold: 0.1 },
      () => undefined,
    )).rejects.toThrow('No opaque voxel cells were produced');
  });

  it('ignores base-color, texture, and vertex alpha for OPAQUE materials', async () => {
    const transparent = new Uint8ClampedArray([
      255, 0, 0, 0, 255, 0, 0, 0,
      255, 0, 0, 0, 255, 0, 0, 0,
    ]);
    const source = makeTexturedPlane(makeTexture(transparent, 2, 2));
    const mesh = source.scene.children[0] as Mesh;
    const material = mesh.material as MeshStandardMaterial;
    material.opacity = 0;
    material.transparent = false;
    material.vertexColors = true;
    const positions = mesh.geometry.attributes.position as BufferAttribute;
    const colors = new Float32Array(positions.count * 4);
    for (let index = 0; index < positions.count; index += 1) {
      colors.set([1, 1, 1, 0], index * 4);
    }
    mesh.geometry.setAttribute('color', new BufferAttribute(colors, 4));

    const result = await voxelizeModel(source, { ...baseOptions, alphaThreshold: 0.9 }, () => undefined);

    expect(result.voxels.length).toBeGreaterThan(0);
    expect(result.voxels.every((voxel) => voxel.r > voxel.g && voxel.r > voxel.b)).toBe(true);
  });

  it('interpolates and multiplies VEC4 COLOR_0 alpha for BLEND materials', async () => {
    const source = makeTexturedPlane(makeTexture(new Uint8ClampedArray([
      255, 255, 255, 255, 255, 255, 255, 255,
      255, 255, 255, 255, 255, 255, 255, 255,
    ]), 2, 2));
    const mesh = source.scene.children[0] as Mesh;
    const material = mesh.material as MeshStandardMaterial;
    material.transparent = true;
    material.opacity = 0.8;
    material.vertexColors = true;
    const positions = mesh.geometry.attributes.position as BufferAttribute;
    const colors = new Float32Array(positions.count * 4);
    for (let index = 0; index < positions.count; index += 1) {
      colors.set([1, 1, 1, 0.5], index * 4);
    }
    mesh.geometry.setAttribute('color', new BufferAttribute(colors, 4));

    // Combined coverage is 0.8 * 0.5 = 0.4, below this threshold.
    await expect(voxelizeModel(source, { ...baseOptions, alphaThreshold: 0.5 }, () => undefined))
      .rejects.toThrow('No opaque voxel cells were produced');
  });

  it('respects a glTF material alpha cutoff above the global threshold', async () => {
    const translucent = new Uint8ClampedArray([
      255, 0, 0, 128, 255, 0, 0, 128,
      255, 0, 0, 128, 255, 0, 0, 128,
    ]);
    const source = makeTexturedPlane(makeTexture(translucent, 2, 2));
    const mesh = source.scene.children[0] as Mesh;
    (mesh.material as MeshStandardMaterial).alphaTest = 0.75;
    await expect(voxelizeModel(source, { ...baseOptions, alphaThreshold: 0.1 }, () => undefined))
      .rejects.toThrow('No opaque voxel cells were produced');
  });

  it('can bake emissive material details into visible appearance colors', async () => {
    const source = makeSource();
    const mesh = source.scene.children[0] as Mesh;
    mesh.material = new MeshStandardMaterial({ color: '#000000', emissive: '#ff2a20', emissiveIntensity: 1 });
    const baseColor = await voxelizeModel(source, { ...baseOptions, materialColorMode: 'baseColor' }, () => undefined);
    const appearance = await voxelizeModel(source, { ...baseOptions, materialColorMode: 'appearance' }, () => undefined);
    expect(Math.max(...baseColor.voxels.map((voxel) => voxel.r))).toBeLessThan(10);
    expect(Math.min(...appearance.voxels.map((voxel) => voxel.r))).toBeGreaterThan(200);
    expect(Math.min(...appearance.voxels.map((voxel) => voxel.r - voxel.b))).toBeGreaterThan(100);
  });
});

describe('stabilizeSurfacePaletteIndices', () => {
  it('corrects a single unsupported color speckle enclosed by a flat surface patch', () => {
    const width = 5;
    const height = 5;
    const { state, colors } = surfaceLayer(width, height);
    const center = layerIndex(2, 2, width);
    colors[center] = 1;

    const stabilized = stabilizeSurfacePaletteIndices(state, colors, width, height, 1);

    expect(stabilized[center]).toBe(0);
    expect(Array.from(stabilized).filter((color) => color !== 0)).toEqual([]);
  });

  it('preserves connected one-voxel stripes and unsupported colors on geometry edges', () => {
    const width = 7;
    const height = 7;
    const { state, colors } = surfaceLayer(width, height);
    for (let y = 0; y < height; y += 1) colors[layerIndex(3, y, width)] = 1;
    const edgeAccent = layerIndex(0, 3, width);
    colors[edgeAccent] = 2;

    const stabilized = stabilizeSurfacePaletteIndices(state, colors, width, height, 1);

    for (let y = 0; y < height; y += 1) {
      expect(stabilized[layerIndex(3, y, width)]).toBe(1);
    }
    expect(stabilized[edgeAccent]).toBe(2);
  });

  it('is deterministic, synchronous, and does not mutate its palette-index input', () => {
    const width = 7;
    const height = 7;
    const { state, colors } = surfaceLayer(width, height);
    colors[layerIndex(2, 2, width)] = 1;
    colors[layerIndex(4, 4, width)] = 2;
    const original = colors.slice();

    const first = stabilizeSurfacePaletteIndices(state, colors, width, height, 1);
    const second = stabilizeSurfacePaletteIndices(state, colors, width, height, 1);

    expect(first).toEqual(second);
    expect(colors).toEqual(original);
    expect(first[layerIndex(2, 2, width)]).toBe(0);
    expect(first[layerIndex(4, 4, width)]).toBe(0);
  });
});
