import type { RGB, Voxel, VoxelModel } from '../types';
import { srgbToLinear } from './palette';
import {
  isSupportedVoxelCoordinate,
  MAX_VOXEL_COORDINATE,
  packVoxelCoordinate,
  VOXEL_COORDINATE_LIMIT,
} from './voxelIndex';

const encoder = new TextEncoder();

const GLB_MAGIC = 0x46546c67;
const GLB_VERSION = 2;
const JSON_CHUNK_TYPE = 0x4e4f534a;
const BIN_CHUNK_TYPE = 0x004e4942;
const ARRAY_BUFFER_TARGET = 34962;
const ELEMENT_ARRAY_BUFFER_TARGET = 34963;
const FLOAT_COMPONENT_TYPE = 5126;
const UNSIGNED_SHORT_COMPONENT_TYPE = 5123;
const UNSIGNED_INT_COMPONENT_TYPE = 5125;

type Axis = 0 | 1 | 2;
type Vec3 = [number, number, number];

interface FaceDirection {
  axis: Axis;
  sign: -1 | 1;
  normal: Vec3;
  uAxis: Axis;
  vAxis: Axis;
}

interface FaceGroup {
  directionIndex: number;
  plane: number;
  colorIndex: number;
  cells: Set<number>;
}

interface MeshData {
  positions: number[];
  normals: number[];
  colors: number[];
  indices: number[];
  min: Vec3;
  max: Vec3;
}

interface BinaryPart {
  bytes: Uint8Array;
  target: number;
}

interface GlbDocument {
  asset: { version: string; generator: string };
  scene: number;
  scenes: Array<{ nodes: number[] }>;
  nodes: Array<Record<string, unknown>>;
  meshes?: Array<Record<string, unknown>>;
  materials?: Array<Record<string, unknown>>;
  buffers?: Array<{ byteLength: number }>;
  bufferViews?: Array<{ buffer: number; byteOffset: number; byteLength: number; target: number }>;
  accessors?: Array<Record<string, unknown>>;
}

// Each direction chooses in-plane U and V axes whose cross product points out
// of the model. The shared quad winding can therefore be used for all faces.
const FACE_DIRECTIONS: readonly FaceDirection[] = [
  { axis: 0, sign: -1, normal: [-1, 0, 0], uAxis: 2, vAxis: 1 },
  { axis: 0, sign: 1, normal: [1, 0, 0], uAxis: 1, vAxis: 2 },
  { axis: 1, sign: -1, normal: [0, -1, 0], uAxis: 0, vAxis: 2 },
  { axis: 1, sign: 1, normal: [0, 1, 0], uAxis: 2, vAxis: 0 },
  { axis: 2, sign: -1, normal: [0, 0, -1], uAxis: 1, vAxis: 0 },
  { axis: 2, sign: 1, normal: [0, 0, 1], uAxis: 0, vAxis: 1 },
] as const;

function safeName(value: string) {
  return value.replace(/\.[^.]+$/u, '').replace(/[^a-z0-9_-]+/giu, '-').replace(/^-+|-+$/gu, '') || 'model';
}

function validateModel(model: VoxelModel) {
  if (![model.size.x, model.size.y, model.size.z]
    .every((dimension) => Number.isInteger(dimension) && dimension > 0 && dimension <= VOXEL_COORDINATE_LIMIT)) {
    throw new RangeError(`GLB model dimensions must be integers between 1 and ${VOXEL_COORDINATE_LIMIT}.`);
  }
  if (!Number.isFinite(model.voxelSize) || model.voxelSize <= 0) {
    throw new RangeError('GLB voxel size must be a finite number greater than zero.');
  }
  const floatVoxelSize = Math.fround(model.voxelSize);
  const maximumWorldExtent = Math.fround(Math.max(model.size.x, model.size.y, model.size.z) * model.voxelSize);
  if (!Number.isFinite(floatVoxelSize) || floatVoxelSize <= 0 || !Number.isFinite(maximumWorldExtent)) {
    throw new RangeError('GLB voxel size must remain a finite, non-zero float32 value at the model bounds.');
  }
  if (!model.palette.length || model.palette.length > 255) {
    throw new RangeError('GLB models require between 1 and 255 palette colors.');
  }
  if (!model.palette.every((color) => [color.r, color.g, color.b]
    .every((channel) => Number.isInteger(channel) && channel >= 0 && channel <= 255))) {
    throw new RangeError('The GLB palette contains an invalid RGB value.');
  }

  const coordinates = new Set<number>();
  for (const voxel of model.voxels) {
    if (!isSupportedVoxelCoordinate(voxel)
      || voxel.x >= model.size.x || voxel.y >= model.size.y || voxel.z >= model.size.z
      || !Number.isInteger(voxel.colorIndex)
      || voxel.colorIndex < 0 || voxel.colorIndex >= model.palette.length) {
      throw new RangeError(`GLB voxel coordinates must be inside the model and between 0 and ${MAX_VOXEL_COORDINATE}, with a valid palette index.`);
    }
    const key = packVoxelCoordinate(voxel);
    if (coordinates.has(key)) throw new RangeError('The GLB model contains duplicate voxel coordinates.');
    coordinates.add(key);
  }
}

const component = (voxel: Voxel, axis: Axis) => axis === 0 ? voxel.x : axis === 1 ? voxel.y : voxel.z;

function isInside(model: VoxelModel, coordinate: Vec3) {
  return coordinate[0] >= 0 && coordinate[0] < model.size.x
    && coordinate[1] >= 0 && coordinate[1] < model.size.y
    && coordinate[2] >= 0 && coordinate[2] < model.size.z;
}

function faceGroups(model: VoxelModel): FaceGroup[] {
  const sortedVoxels = [...model.voxels].sort((a, b) => a.z - b.z || a.y - b.y || a.x - b.x);
  const occupied = new Set(sortedVoxels.map(packVoxelCoordinate));
  const groups = new Map<string, FaceGroup>();

  for (const voxel of sortedVoxels) {
    const coordinate: Vec3 = [voxel.x, voxel.y, voxel.z];
    FACE_DIRECTIONS.forEach((direction, directionIndex) => {
      const neighbor = [...coordinate] as Vec3;
      neighbor[direction.axis] += direction.sign;
      if (isInside(model, neighbor)
        && occupied.has(packVoxelCoordinate({ x: neighbor[0], y: neighbor[1], z: neighbor[2] }))) return;

      const plane = component(voxel, direction.axis) + (direction.sign > 0 ? 1 : 0);
      const u = component(voxel, direction.uAxis);
      const v = component(voxel, direction.vAxis);
      const key = `${directionIndex}:${plane}:${voxel.colorIndex}`;
      let group = groups.get(key);
      if (!group) {
        group = { directionIndex, plane, colorIndex: voxel.colorIndex, cells: new Set() };
        groups.set(key, group);
      }
      group.cells.add(u + v * VOXEL_COORDINATE_LIMIT);
    });
  }

  return [...groups.values()].sort((a, b) => a.directionIndex - b.directionIndex
    || a.plane - b.plane || a.colorIndex - b.colorIndex);
}

function worldPoint(model: VoxelModel, gridPoint: Vec3): Vec3 {
  return [
    Math.fround((gridPoint[0] - model.size.x / 2) * model.voxelSize),
    Math.fround((gridPoint[1] - model.size.y / 2) * model.voxelSize),
    Math.fround((gridPoint[2] - model.size.z / 2) * model.voxelSize),
  ];
}

function buildMesh(model: VoxelModel): MeshData | null {
  if (!model.voxels.length) return null;
  const positions: number[] = [];
  const normals: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];
  const min: Vec3 = [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY];
  const max: Vec3 = [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY];

  for (const group of faceGroups(model)) {
    const direction = FACE_DIRECTIONS[group.directionIndex];
    const cells = new Set(group.cells);
    const orderedCells = [...cells].sort((a, b) => a - b);
    const color = model.palette[group.colorIndex];
    const linearColor: Vec3 = [srgbToLinear(color.r), srgbToLinear(color.g), srgbToLinear(color.b)];

    for (const cell of orderedCells) {
      if (!cells.has(cell)) continue;
      const u = cell % VOXEL_COORDINATE_LIMIT;
      const v = Math.floor(cell / VOXEL_COORDINATE_LIMIT);
      let width = 1;
      while (u + width < VOXEL_COORDINATE_LIMIT
        && cells.has(u + width + v * VOXEL_COORDINATE_LIMIT)) width += 1;
      let height = 1;
      heightLoop: for (;; height += 1) {
        if (v + height >= VOXEL_COORDINATE_LIMIT) break;
        for (let offset = 0; offset < width; offset += 1) {
          if (!cells.has(u + offset + (v + height) * VOXEL_COORDINATE_LIMIT)) break heightLoop;
        }
      }
      for (let row = 0; row < height; row += 1) {
        for (let column = 0; column < width; column += 1) {
          cells.delete(u + column + (v + row) * VOXEL_COORDINATE_LIMIT);
        }
      }

      const points: Vec3[] = [[0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0]];
      for (const point of points) point[direction.axis] = group.plane;
      points[0][direction.uAxis] = u;
      points[0][direction.vAxis] = v;
      points[1][direction.uAxis] = u + width;
      points[1][direction.vAxis] = v;
      points[2][direction.uAxis] = u + width;
      points[2][direction.vAxis] = v + height;
      points[3][direction.uAxis] = u;
      points[3][direction.vAxis] = v + height;

      const firstVertex = positions.length / 3;
      for (const point of points.map((entry) => worldPoint(model, entry))) {
        positions.push(...point);
        normals.push(...direction.normal);
        colors.push(...linearColor, 1);
        for (let axis = 0; axis < 3; axis += 1) {
          min[axis] = Math.min(min[axis], point[axis]);
          max[axis] = Math.max(max[axis], point[axis]);
        }
      }
      indices.push(firstVertex, firstVertex + 1, firstVertex + 2, firstVertex, firstVertex + 2, firstVertex + 3);
    }
  }

  return { positions, normals, colors, indices, min, max };
}

function float32Bytes(values: number[]): Uint8Array {
  const bytes = new Uint8Array(values.length * 4);
  const view = new DataView(bytes.buffer);
  values.forEach((value, index) => view.setFloat32(index * 4, value, true));
  return bytes;
}

function indexBytes(values: number[], useUint32: boolean): Uint8Array {
  const bytes = new Uint8Array(values.length * (useUint32 ? 4 : 2));
  const view = new DataView(bytes.buffer);
  values.forEach((value, index) => {
    if (useUint32) view.setUint32(index * 4, value, true);
    else view.setUint16(index * 2, value, true);
  });
  return bytes;
}

function assembleBinary(parts: BinaryPart[]) {
  const offsets: number[] = [];
  let length = 0;
  for (const part of parts) {
    length = (length + 3) & ~3;
    offsets.push(length);
    length += part.bytes.length;
  }
  const bytes = new Uint8Array((length + 3) & ~3);
  parts.forEach((part, index) => bytes.set(part.bytes, offsets[index]));
  return { bytes, offsets };
}

function metadata(model: VoxelModel) {
  return {
    voxelmill: {
      voxelSize: model.voxelSize,
      dimensions: [model.size.x, model.size.y, model.size.z],
      palette: model.palette.map(({ r, g, b }: RGB) => [r, g, b]),
      origin: 'centered',
    },
  };
}

function documentForModel(model: VoxelModel, mesh: MeshData | null): { document: GlbDocument; binary?: Uint8Array } {
  const node: Record<string, unknown> = { name: safeName(model.sourceName), extras: metadata(model) };
  const document: GlbDocument = {
    asset: { version: '2.0', generator: 'VoxelMill' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [node],
  };
  if (!mesh) return { document };
  if (mesh.positions.length / 3 > 0xffffffff) throw new RangeError('The GLB mesh contains too many vertices.');

  const vertexCount = mesh.positions.length / 3;
  // UNSIGNED_SHORT can address vertices 0..65,535. A mesh with exactly
  // 65,536 vertices therefore already needs 32-bit indices.
  const useUint32 = vertexCount >= 0x10000;
  const parts: BinaryPart[] = [
    { bytes: float32Bytes(mesh.positions), target: ARRAY_BUFFER_TARGET },
    { bytes: float32Bytes(mesh.normals), target: ARRAY_BUFFER_TARGET },
    { bytes: float32Bytes(mesh.colors), target: ARRAY_BUFFER_TARGET },
    { bytes: indexBytes(mesh.indices, useUint32), target: ELEMENT_ARRAY_BUFFER_TARGET },
  ];
  const binary = assembleBinary(parts);
  const bufferViews = parts.map((part, index) => ({
    buffer: 0,
    byteOffset: binary.offsets[index],
    byteLength: part.bytes.byteLength,
    target: part.target,
  }));

  node.mesh = 0;
  document.buffers = [{ byteLength: binary.bytes.byteLength }];
  document.bufferViews = bufferViews;
  document.accessors = [
    {
      bufferView: 0,
      componentType: FLOAT_COMPONENT_TYPE,
      count: vertexCount,
      type: 'VEC3',
      min: mesh.min,
      max: mesh.max,
    },
    { bufferView: 1, componentType: FLOAT_COMPONENT_TYPE, count: vertexCount, type: 'VEC3' },
    { bufferView: 2, componentType: FLOAT_COMPONENT_TYPE, count: vertexCount, type: 'VEC4' },
    {
      bufferView: 3,
      componentType: useUint32 ? UNSIGNED_INT_COMPONENT_TYPE : UNSIGNED_SHORT_COMPONENT_TYPE,
      count: mesh.indices.length,
      type: 'SCALAR',
      min: [0],
      max: [vertexCount - 1],
    },
  ];
  document.materials = [{
    name: 'Voxel colors',
    pbrMetallicRoughness: {
      baseColorFactor: [1, 1, 1, 1],
      metallicFactor: 0,
      roughnessFactor: 0.9,
    },
  }];
  document.meshes = [{
    name: `${safeName(model.sourceName)}-voxels`,
    primitives: [{
      attributes: { POSITION: 0, NORMAL: 1, COLOR_0: 2 },
      indices: 3,
      material: 0,
      mode: 4,
    }],
    extras: metadata(model),
  }];
  return { document, binary: binary.bytes };
}

function paddedJson(value: unknown): Uint8Array {
  const encoded = encoder.encode(JSON.stringify(value));
  const bytes = new Uint8Array((encoded.length + 3) & ~3);
  bytes.fill(0x20);
  bytes.set(encoded);
  return bytes;
}

/** Encodes an edited VoxelMill model as a self-contained glTF 2.0 binary. */
export function encodeGlb(model: VoxelModel): Uint8Array {
  validateModel(model);
  const { document, binary } = documentForModel(model, buildMesh(model));
  const json = paddedJson(document);
  const totalLength = 12 + 8 + json.length + (binary ? 8 + binary.length : 0);
  const output = new Uint8Array(totalLength);
  const view = new DataView(output.buffer);
  view.setUint32(0, GLB_MAGIC, true);
  view.setUint32(4, GLB_VERSION, true);
  view.setUint32(8, totalLength, true);
  view.setUint32(12, json.length, true);
  view.setUint32(16, JSON_CHUNK_TYPE, true);
  output.set(json, 20);
  if (binary) {
    const offset = 20 + json.length;
    view.setUint32(offset, binary.length, true);
    view.setUint32(offset + 4, BIN_CHUNK_TYPE, true);
    output.set(binary, offset + 8);
  }
  return output;
}

export function downloadGlb(model: VoxelModel) {
  const bytes = encodeGlb(model);
  const url = URL.createObjectURL(new Blob([bytes], { type: 'model/gltf-binary' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `${safeName(model.sourceName)}-${model.size.x}x${model.size.y}x${model.size.z}.glb`;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
