import { describe, expect, it } from 'vitest';
import type { RGB, Voxel, VoxelModel } from '../types';
import { srgbToLinear } from './palette';
import { encodeGlb } from './glbExport';
import { MAX_VOXEL_COORDINATE, VOXEL_COORDINATE_LIMIT } from './voxelIndex';

const decoder = new TextDecoder();

interface GltfBufferView {
  buffer: number;
  byteOffset?: number;
  byteLength: number;
  byteStride?: number;
  target?: number;
}

interface GltfAccessor {
  bufferView: number;
  byteOffset?: number;
  componentType: number;
  count: number;
  type: 'SCALAR' | 'VEC2' | 'VEC3' | 'VEC4';
  min?: number[];
  max?: number[];
}

interface GltfDocument {
  asset: { version: string; generator?: string };
  scene: number;
  scenes: Array<{ nodes: number[] }>;
  nodes: Array<{ mesh?: number; extras?: Record<string, unknown> }>;
  meshes?: Array<{
    primitives: Array<{
      attributes: Record<string, number>;
      indices: number;
      material?: number;
      mode?: number;
    }>;
    extras?: Record<string, unknown>;
  }>;
  materials?: Array<Record<string, unknown>>;
  buffers?: Array<{ byteLength: number }>;
  bufferViews?: GltfBufferView[];
  accessors?: GltfAccessor[];
}

interface ParsedGlb {
  document: GltfDocument;
  binary?: Uint8Array;
  chunkTypes: number[];
}

function parseGlb(bytes: Uint8Array): ParsedGlb {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== 0x46546c67) throw new Error('Missing glTF signature.');
  if (view.getUint32(4, true) !== 2) throw new Error('Unsupported GLB version.');
  if (view.getUint32(8, true) !== bytes.byteLength) throw new Error('Incorrect GLB byte length.');

  let cursor = 12;
  let json: Uint8Array | undefined;
  let binary: Uint8Array | undefined;
  const chunkTypes: number[] = [];
  while (cursor < bytes.byteLength) {
    if (cursor + 8 > bytes.byteLength) throw new Error('Truncated GLB chunk header.');
    const length = view.getUint32(cursor, true);
    const type = view.getUint32(cursor + 4, true);
    const start = cursor + 8;
    const end = start + length;
    if (length % 4 || end > bytes.byteLength) throw new Error('Invalid GLB chunk alignment or length.');
    chunkTypes.push(type);
    if (type === 0x4e4f534a) json = bytes.slice(start, end);
    if (type === 0x004e4942) binary = bytes.slice(start, end);
    cursor = end;
  }
  if (cursor !== bytes.byteLength || !json) throw new Error('GLB does not contain a complete JSON chunk.');
  return { document: JSON.parse(decoder.decode(json)) as GltfDocument, binary, chunkTypes };
}

const componentCount = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 } as const;

function readAccessor(parsed: ParsedGlb, accessorIndex: number): number[][] {
  const accessor = parsed.document.accessors?.[accessorIndex];
  const bufferView = accessor && parsed.document.bufferViews?.[accessor.bufferView];
  if (!accessor || !bufferView || !parsed.binary) throw new Error('Accessor is missing its binary data.');
  const bytesPerComponent = accessor.componentType === 5126 || accessor.componentType === 5125 ? 4
    : accessor.componentType === 5123 ? 2 : 1;
  const components = componentCount[accessor.type];
  const stride = bufferView.byteStride ?? components * bytesPerComponent;
  const baseOffset = (bufferView.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
  const data = new DataView(parsed.binary.buffer, parsed.binary.byteOffset, parsed.binary.byteLength);
  const readComponent = (offset: number) => {
    if (accessor.componentType === 5126) return data.getFloat32(offset, true);
    if (accessor.componentType === 5125) return data.getUint32(offset, true);
    if (accessor.componentType === 5123) return data.getUint16(offset, true);
    return data.getUint8(offset);
  };
  return Array.from({ length: accessor.count }, (_, index) => Array.from(
    { length: components },
    (__, componentIndex) => readComponent(baseOffset + index * stride + componentIndex * bytesPerComponent),
  ));
}

function modelWith(voxels: Array<{ x: number; y: number; z: number; colorIndex?: number }>, options: {
  size?: VoxelModel['size'];
  voxelSize?: number;
  palette?: RGB[];
} = {}): VoxelModel {
  const palette = options.palette ?? [{ r: 128, g: 64, b: 32 }];
  return {
    sourceName: 'painted model.glb',
    voxelSize: options.voxelSize ?? 1,
    size: options.size ?? { x: 1, y: 1, z: 1 },
    palette,
    voxels: voxels.map((voxel): Voxel => {
      const colorIndex = voxel.colorIndex ?? 0;
      return { ...voxel, colorIndex, ...palette[colorIndex] };
    }),
  };
}

function primitiveAccessors(document: GltfDocument) {
  const primitive = document.meshes?.[0]?.primitives[0];
  if (!primitive) throw new Error('Missing mesh primitive.');
  return {
    primitive,
    position: primitive.attributes.POSITION,
    normal: primitive.attributes.NORMAL,
    color: primitive.attributes.COLOR_0,
    indices: primitive.indices,
  };
}

const cross = (a: number[], b: number[]) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];

describe('encodeGlb', () => {
  it('writes a self-contained glTF 2.0 binary with aligned JSON and BIN chunks', () => {
    const bytes = encodeGlb(modelWith([{ x: 0, y: 0, z: 0 }]));
    const parsed = parseGlb(bytes);

    expect(decoder.decode(bytes.slice(0, 4))).toBe('glTF');
    expect(parsed.chunkTypes).toEqual([0x4e4f534a, 0x004e4942]);
    expect(parsed.document.asset).toEqual({ version: '2.0', generator: 'VoxelMill' });
    expect(parsed.document.scene).toBe(0);
    expect(parsed.document.scenes[0].nodes).toEqual([0]);
    expect(parsed.document.nodes[0].mesh).toBe(0);
    expect(parsed.document.buffers?.[0].byteLength).toBe(parsed.binary?.byteLength);
    expect(parsed.document.bufferViews?.map((entry) => entry.byteOffset! % 4)).toEqual([0, 0, 0, 0]);
    expect(parsed.document.bufferViews?.map((entry) => entry.target)).toEqual([34962, 34962, 34962, 34963]);
    expect(primitiveAccessors(parsed.document).primitive).toMatchObject({ material: 0, mode: 4 });
  });

  it('uses voxelSize for centered physical bounds and emits outward normals and winding', () => {
    const parsed = parseGlb(encodeGlb(modelWith(
      [{ x: 0, y: 0, z: 0 }],
      { voxelSize: 0.25 },
    )));
    const accessors = primitiveAccessors(parsed.document);
    const positions = readAccessor(parsed, accessors.position);
    const normals = readAccessor(parsed, accessors.normal);
    const indices = readAccessor(parsed, accessors.indices).flat();
    const positionAccessor = parsed.document.accessors?.[accessors.position];

    expect(positionAccessor?.count).toBe(24);
    expect(positionAccessor?.min).toEqual([-0.125, -0.125, -0.125]);
    expect(positionAccessor?.max).toEqual([0.125, 0.125, 0.125]);
    expect(parsed.document.accessors?.[accessors.indices].count).toBe(36);
    expect(new Set(normals.map((normal) => normal.join(',')))).toEqual(new Set([
      '-1,0,0', '1,0,0', '0,-1,0', '0,1,0', '0,0,-1', '0,0,1',
    ]));

    for (let offset = 0; offset < indices.length; offset += 3) {
      const a = positions[indices[offset]];
      const b = positions[indices[offset + 1]];
      const c = positions[indices[offset + 2]];
      const edgeA = b.map((value, axis) => value - a[axis]);
      const edgeB = c.map((value, axis) => value - a[axis]);
      const faceNormal = cross(edgeA, edgeB);
      expect(faceNormal.reduce((sum, value, axis) => sum + value * normals[indices[offset]][axis], 0)).toBeGreaterThan(0);
    }
  });

  it('preserves exact palette metadata and linear-light COLOR_0 appearance', () => {
    const palette = [{ r: 128, g: 64, b: 32 }, { r: 20, g: 180, b: 240 }];
    const model = modelWith([
      { x: 0, y: 0, z: 0, colorIndex: 0 },
      { x: 2, y: 0, z: 0, colorIndex: 1 },
    ], { size: { x: 3, y: 1, z: 1 }, palette });
    const parsed = parseGlb(encodeGlb(model));
    const accessors = primitiveAccessors(parsed.document);
    const colors = readAccessor(parsed, accessors.color);
    const distinctColors = [...new Map(colors.map((color) => [color.join(','), color])).values()];

    expect(parsed.document.accessors?.[accessors.color]).toMatchObject({ componentType: 5126, type: 'VEC4' });
    expect(distinctColors).toHaveLength(2);
    for (const color of palette) {
      const expected = [srgbToLinear(color.r), srgbToLinear(color.g), srgbToLinear(color.b), 1];
      expect(distinctColors.some((candidate) => candidate.every((value, index) =>
        Math.abs(value - expected[index]) < 1e-6))).toBe(true);
    }
    expect((parsed.document.meshes?.[0].extras as {
      voxelmill: { palette: number[][]; voxelSize: number; dimensions: number[] };
    }).voxelmill).toEqual({
      palette: [[128, 64, 32], [20, 180, 240]],
      voxelSize: 1,
      dimensions: [3, 1, 1],
      origin: 'centered',
    });
  });

  it('greedily merges a solid same-color block into six quads', () => {
    const voxels = Array.from({ length: 8 }, (_, index) => ({
      x: index & 1,
      y: (index >> 1) & 1,
      z: (index >> 2) & 1,
    }));
    const parsed = parseGlb(encodeGlb(modelWith(voxels, { size: { x: 2, y: 2, z: 2 } })));
    const accessors = primitiveAccessors(parsed.document);

    expect(parsed.document.accessors?.[accessors.position].count).toBe(24);
    expect(parsed.document.accessors?.[accessors.indices].count).toBe(36);
    expect(parsed.document.accessors?.[accessors.position].min).toEqual([-1, -1, -1]);
    expect(parsed.document.accessors?.[accessors.position].max).toEqual([1, 1, 1]);
  });

  it('promotes sparse meshes beyond 65,535 vertices to 32-bit indices', () => {
    const side = 14;
    const voxels = Array.from({ length: side ** 3 }, (_, index) => ({
      x: (index % side) * 2,
      y: (Math.floor(index / side) % side) * 2,
      z: Math.floor(index / side ** 2) * 2,
    }));
    const parsed = parseGlb(encodeGlb(modelWith(voxels, {
      size: { x: side * 2 - 1, y: side * 2 - 1, z: side * 2 - 1 },
    })));
    const accessors = primitiveAccessors(parsed.document);
    const positionAccessor = parsed.document.accessors?.[accessors.position];
    const indexAccessor = parsed.document.accessors?.[accessors.indices];
    const indices = readAccessor(parsed, accessors.indices).flat();

    expect(positionAccessor?.count).toBe(65_856);
    expect(indexAccessor).toMatchObject({ componentType: 5125, count: 98_784, max: [65_855] });
    expect(indices.reduce((maximum, value) => Math.max(maximum, value), 0)).toBe(65_855);
  });

  it('promotes a mesh with exactly 65,536 vertices to 32-bit indices', () => {
    const isolatedVoxels = Array.from({ length: 2_729 }, (_, index) => ({
      x: (index % 14) * 2,
      y: (Math.floor(index / 14) % 14) * 2,
      z: Math.floor(index / 14 ** 2) * 2,
      colorIndex: 0,
    }));
    const parsed = parseGlb(encodeGlb(modelWith([
      ...isolatedVoxels,
      { x: 29, y: 0, z: 0, colorIndex: 0 },
      { x: 30, y: 0, z: 0, colorIndex: 1 },
    ], {
      size: { x: 31, y: 27, z: 27 },
      palette: [{ r: 255, g: 0, b: 0 }, { r: 0, g: 0, b: 255 }],
    })));
    const accessors = primitiveAccessors(parsed.document);
    const positionAccessor = parsed.document.accessors?.[accessors.position];
    const indexAccessor = parsed.document.accessors?.[accessors.indices];
    const indices = readAccessor(parsed, accessors.indices).flat();

    expect(positionAccessor?.count).toBe(65_536);
    expect(indexAccessor).toMatchObject({ componentType: 5125, max: [65_535] });
    expect(indices.reduce((maximum, value) => Math.max(maximum, value), 0)).toBe(65_535);
  });

  it('does not merge differently-colored exposed faces or emit their internal face', () => {
    const palette = [{ r: 255, g: 0, b: 0 }, { r: 0, g: 0, b: 255 }];
    const parsed = parseGlb(encodeGlb(modelWith([
      { x: 0, y: 0, z: 0, colorIndex: 0 },
      { x: 1, y: 0, z: 0, colorIndex: 1 },
    ], { size: { x: 2, y: 1, z: 1 }, palette })));
    const accessors = primitiveAccessors(parsed.document);

    // Ten exposed quads remain: two end caps and two color regions on each of
    // the four long sides. The occupied shared face is omitted.
    expect(parsed.document.accessors?.[accessors.position].count).toBe(40);
    expect(parsed.document.accessors?.[accessors.indices].count).toBe(60);
  });

  it('is byte-for-byte deterministic regardless of voxel input order', () => {
    const palette = [{ r: 10, g: 20, b: 30 }, { r: 230, g: 180, b: 40 }];
    const coordinates = [
      { x: 2, y: 0, z: 1, colorIndex: 1 },
      { x: 0, y: 1, z: 0, colorIndex: 0 },
      { x: 1, y: 1, z: 0, colorIndex: 0 },
      { x: 2, y: 1, z: 1, colorIndex: 1 },
    ];
    const options = { size: { x: 3, y: 2, z: 2 }, palette };

    expect(encodeGlb(modelWith(coordinates, options)))
      .toEqual(encodeGlb(modelWith([...coordinates].reverse(), options)));
  });

  it('exports an empty edited model as a valid metadata-only GLB scene', () => {
    const parsed = parseGlb(encodeGlb(modelWith([], { size: { x: 8, y: 4, z: 2 }, voxelSize: 0.5 })));

    expect(parsed.chunkTypes).toEqual([0x4e4f534a]);
    expect(parsed.binary).toBeUndefined();
    expect(parsed.document.meshes).toBeUndefined();
    expect(parsed.document.nodes[0].mesh).toBeUndefined();
  });

  it('enforces the shared 0..1023 coordinate and model contract', () => {
    expect(() => encodeGlb(modelWith(
      [{ x: MAX_VOXEL_COORDINATE, y: MAX_VOXEL_COORDINATE, z: MAX_VOXEL_COORDINATE }],
      { size: { x: VOXEL_COORDINATE_LIMIT, y: VOXEL_COORDINATE_LIMIT, z: VOXEL_COORDINATE_LIMIT } },
    ))).not.toThrow();
    expect(() => encodeGlb(modelWith([], {
      size: { x: VOXEL_COORDINATE_LIMIT + 1, y: 1, z: 1 },
    }))).toThrow('dimensions');
    expect(() => encodeGlb(modelWith(
      [{ x: VOXEL_COORDINATE_LIMIT, y: 0, z: 0 }],
      { size: { x: VOXEL_COORDINATE_LIMIT, y: 1, z: 1 } },
    ))).toThrow('coordinates');
    expect(() => encodeGlb({
      ...modelWith([{ x: 0, y: 0, z: 0 }]),
      voxels: [
        ...modelWith([{ x: 0, y: 0, z: 0 }]).voxels,
        ...modelWith([{ x: 0, y: 0, z: 0 }]).voxels,
      ],
    })).toThrow('duplicate');
    expect(() => encodeGlb({ ...modelWith([]), voxelSize: 0 })).toThrow('voxel size');
    expect(() => encodeGlb({ ...modelWith([]), voxelSize: Number.MAX_VALUE })).toThrow('float32');
    expect(() => encodeGlb({ ...modelWith([]), voxelSize: Number.MIN_VALUE })).toThrow('float32');
  });
});
