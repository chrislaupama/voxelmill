import type { RGB, Voxel, VoxelCoordinate, VoxelModel } from '../types';
import { isSupportedVoxelCoordinate, VOXEL_COORDINATE_LIMIT } from './voxelIndex';

const decoder = new TextDecoder('utf-8', { fatal: true });
const IDENTITY_MATRIX: Matrix3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];
const IDENTITY_TRANSFORM: Transform = { matrix: IDENTITY_MATRIX, translation: { x: 0, y: 0, z: 0 } };

type Matrix3 = [number, number, number, number, number, number, number, number, number];
type VoxDictionary = Map<string, string>;

interface Transform {
  matrix: Matrix3;
  translation: VoxelCoordinate;
}

interface ParsedChunk {
  id: string;
  contentStart: number;
  contentEnd: number;
}

interface StoredVoxel extends VoxelCoordinate {
  paletteIndex: number;
}

interface StoredModel {
  size: VoxelCoordinate;
  voxels: StoredVoxel[];
}

interface TransformNode {
  kind: 'transform';
  id: number;
  child: number;
  transform: Transform;
  hidden: boolean;
  layerId: number;
}

interface GroupNode {
  kind: 'group';
  id: number;
  children: number[];
}

interface ShapeNode {
  kind: 'shape';
  id: number;
  modelId: number;
}

type SceneNode = TransformNode | GroupNode | ShapeNode;

interface ModelInstance {
  modelId: number;
  transform: Transform;
}

interface ParsedVox {
  chunks: ParsedChunk[];
  version: 150 | 200;
}

interface Layer {
  id: number;
  hidden: boolean;
}

export class VoxImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VoxImportError';
  }
}

function invalid(message: string): never {
  throw new VoxImportError(`Invalid VOX file: ${message}`);
}

function bytesFrom(input: ArrayBuffer | Uint8Array): Uint8Array {
  return input instanceof Uint8Array ? input : new Uint8Array(input);
}

function ascii(bytes: Uint8Array, start: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(start, start + length));
}

function uint32(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0, true);
}

function parseChunk(
  bytes: Uint8Array,
  offset: number,
  limit: number,
  chunks: ParsedChunk[],
  depth: number,
): number {
  if (depth > 64) invalid('the chunk hierarchy is too deeply nested.');
  if (offset + 12 > limit) invalid('a chunk header is truncated.');
  const id = ascii(bytes, offset, 4);
  const contentLength = uint32(bytes, offset + 4);
  const childrenLength = uint32(bytes, offset + 8);
  const contentStart = offset + 12;
  const contentEnd = contentStart + contentLength;
  const end = contentEnd + childrenLength;
  if (contentEnd > limit || end > limit) invalid(`chunk ${JSON.stringify(id)} exceeds its parent payload.`);

  chunks.push({ id, contentStart, contentEnd });
  for (let cursor = contentEnd; cursor < end;) {
    const next = parseChunk(bytes, cursor, end, chunks, depth + 1);
    if (next <= cursor) invalid(`chunk ${JSON.stringify(id)} has an invalid child length.`);
    cursor = next;
  }
  return end;
}

function parseChunks(bytes: Uint8Array): ParsedVox {
  if (bytes.length < 20) invalid('the file is truncated.');
  if (ascii(bytes, 0, 4) !== 'VOX ') invalid('the VOX signature is missing.');
  const version = uint32(bytes, 4);
  if (version !== 150 && version !== 200) {
    throw new VoxImportError(`Unsupported VOX version ${version}; supported versions are 150 and 200.`);
  }

  const chunks: ParsedChunk[] = [];
  const end = parseChunk(bytes, 8, bytes.length, chunks, 0);
  const main = chunks.shift();
  if (!main || main.id !== 'MAIN') invalid('the root MAIN chunk is missing.');
  if (end !== bytes.length) invalid('unexpected trailing data follows the MAIN chunk.');
  return { chunks, version };
}

class ContentReader {
  private readonly view: DataView;
  private cursor: number;

  constructor(
    private readonly bytes: Uint8Array,
    private readonly chunk: ParsedChunk,
  ) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.cursor = chunk.contentStart;
  }

  private require(length: number, label: string) {
    if (length < 0 || this.cursor + length > this.chunk.contentEnd) {
      invalid(`${this.chunk.id} is truncated while reading ${label}.`);
    }
  }

  minimumItems(count: number, bytesPerItem: number, label: string) {
    if (count > Math.floor((this.chunk.contentEnd - this.cursor) / bytesPerItem)) {
      invalid(`${this.chunk.id} does not contain enough data for its declared ${label}.`);
    }
  }

  exactBytes(length: number, label: string) {
    if (this.chunk.contentEnd - this.cursor !== length) {
      invalid(`${this.chunk.id} has an invalid byte length for ${label}.`);
    }
  }

  int32(label: string): number {
    this.require(4, label);
    const value = this.view.getInt32(this.cursor, true);
    this.cursor += 4;
    return value;
  }

  uint8(label: string): number {
    this.require(1, label);
    return this.bytes[this.cursor++];
  }

  string(label: string): string {
    const length = this.int32(`${label} length`);
    if (length < 0) invalid(`${this.chunk.id} contains a negative ${label} length.`);
    this.require(length, label);
    let value: string;
    try {
      value = decoder.decode(this.bytes.subarray(this.cursor, this.cursor + length));
    } catch {
      invalid(`${this.chunk.id} contains invalid UTF-8 in ${label}.`);
    }
    this.cursor += length;
    return value!;
  }

  dictionary(label: string): VoxDictionary {
    const count = this.int32(`${label} entry count`);
    if (count < 0) invalid(`${this.chunk.id} contains a negative ${label} entry count.`);
    this.minimumItems(count, 8, `${label} entries`);
    const values = new Map<string, string>();
    for (let index = 0; index < count; index += 1) {
      const key = this.string(`${label} key`);
      const value = this.string(`${label} value`);
      if (values.has(key)) invalid(`${this.chunk.id} contains duplicate dictionary key ${JSON.stringify(key)}.`);
      values.set(key, value);
    }
    return values;
  }

  finish() {
    if (this.cursor !== this.chunk.contentEnd) invalid(`${this.chunk.id} has unexpected trailing content.`);
  }
}

function requireNodeId(value: number, chunkId: string): number {
  if (value < 0) invalid(`${chunkId} contains a negative node id.`);
  return value;
}

function parseInteger(value: string, label: string): number {
  if (!/^[+-]?\d+$/u.test(value.trim())) invalid(`${label} must be an integer.`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) invalid(`${label} is outside the supported integer range.`);
  return parsed;
}

function parseTranslation(value: string | undefined): VoxelCoordinate {
  if (value === undefined) return { x: 0, y: 0, z: 0 };
  const parts = value.trim().split(/\s+/u);
  if (parts.length !== 3) invalid('an nTRN _t value must contain exactly three integers.');
  return {
    x: parseInteger(parts[0], 'nTRN _t x'),
    y: parseInteger(parts[1], 'nTRN _t y'),
    z: parseInteger(parts[2], 'nTRN _t z'),
  };
}

function parseRotation(value: string | undefined): Matrix3 {
  if (value === undefined) return IDENTITY_MATRIX;
  const encoded = parseInteger(value, 'nTRN _r');
  if (encoded < 0 || encoded > 127) invalid('an nTRN _r value must use the seven defined rotation bits.');
  const firstAxis = encoded & 0b11;
  const secondAxis = (encoded >> 2) & 0b11;
  if (firstAxis > 2 || secondAxis > 2 || firstAxis === secondAxis) invalid('an nTRN _r value contains invalid row axes.');
  const thirdAxis = 3 - firstAxis - secondAxis;
  const matrix: Matrix3 = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  matrix[firstAxis] = encoded & 0b1_0000 ? -1 : 1;
  matrix[3 + secondAxis] = encoded & 0b10_0000 ? -1 : 1;
  matrix[6 + thirdAxis] = encoded & 0b100_0000 ? -1 : 1;
  return matrix;
}

function frameIndex(attributes: VoxDictionary, label: string): number {
  const value = attributes.get('_f');
  if (value === undefined) return 0;
  const parsed = parseInteger(value, `${label} _f`);
  if (parsed < 0) invalid(`${label} _f must not be negative.`);
  return parsed;
}

function hiddenAttribute(attributes: VoxDictionary, label: string): boolean {
  const value = attributes.get('_hidden');
  if (value === undefined || value === '0') return false;
  if (value === '1') return true;
  invalid(`${label} _hidden must be 0 or 1.`);
}

function parseTransformNode(bytes: Uint8Array, chunk: ParsedChunk): TransformNode {
  const reader = new ContentReader(bytes, chunk);
  const id = requireNodeId(reader.int32('node id'), chunk.id);
  const nodeAttributes = reader.dictionary('node attributes');
  const child = requireNodeId(reader.int32('child node id'), chunk.id);
  if (reader.int32('reserved id') !== -1) invalid('nTRN reserved id must be -1.');
  const layerId = reader.int32('layer id');
  if (layerId < -1) invalid('nTRN layer id must be -1 or a non-negative integer.');
  const frameCount = reader.int32('frame count');
  if (frameCount <= 0) invalid('nTRN must contain at least one frame.');
  reader.minimumItems(frameCount, 4, 'frames');
  let selected: { index: number; transform: Transform } | undefined;
  for (let index = 0; index < frameCount; index += 1) {
    const attributes = reader.dictionary(`frame ${index} attributes`);
    const candidate = {
      index: frameIndex(attributes, 'nTRN frame'),
      transform: {
        matrix: parseRotation(attributes.get('_r')),
        translation: parseTranslation(attributes.get('_t')),
      },
    };
    if (!selected || candidate.index < selected.index) selected = candidate;
  }
  reader.finish();
  return {
    kind: 'transform',
    id,
    child,
    transform: selected!.transform,
    hidden: hiddenAttribute(nodeAttributes, 'nTRN'),
    layerId,
  };
}

function parseLayer(bytes: Uint8Array, chunk: ParsedChunk): Layer {
  const reader = new ContentReader(bytes, chunk);
  const id = reader.int32('layer id');
  if (id < 0) invalid('LAYR contains a negative layer id.');
  const attributes = reader.dictionary('layer attributes');
  if (reader.int32('reserved id') !== -1) invalid('LAYR reserved id must be -1.');
  reader.finish();
  return { id, hidden: hiddenAttribute(attributes, 'LAYR') };
}

function parseGroupNode(bytes: Uint8Array, chunk: ParsedChunk): GroupNode {
  const reader = new ContentReader(bytes, chunk);
  const id = requireNodeId(reader.int32('node id'), chunk.id);
  reader.dictionary('node attributes');
  const childCount = reader.int32('child count');
  if (childCount < 0) invalid('nGRP contains a negative child count.');
  reader.exactBytes(childCount * 4, 'child node ids');
  const children: number[] = [];
  for (let index = 0; index < childCount; index += 1) {
    children.push(requireNodeId(reader.int32('child node id'), chunk.id));
  }
  reader.finish();
  return { kind: 'group', id, children };
}

function parseShapeNode(bytes: Uint8Array, chunk: ParsedChunk): ShapeNode {
  const reader = new ContentReader(bytes, chunk);
  const id = requireNodeId(reader.int32('node id'), chunk.id);
  reader.dictionary('node attributes');
  const modelCount = reader.int32('model count');
  if (modelCount <= 0) invalid('nSHP must reference at least one model.');
  reader.minimumItems(modelCount, 8, 'models');
  let selected: { index: number; modelId: number } | undefined;
  for (let index = 0; index < modelCount; index += 1) {
    const modelId = reader.int32('model id');
    if (modelId < 0) invalid('nSHP contains a negative model id.');
    const attributes = reader.dictionary(`model ${index} attributes`);
    const candidate = { index: frameIndex(attributes, 'nSHP model'), modelId };
    if (!selected || candidate.index < selected.index) selected = candidate;
  }
  reader.finish();
  return { kind: 'shape', id, modelId: selected!.modelId };
}

function parseSize(bytes: Uint8Array, chunk: ParsedChunk): VoxelCoordinate {
  const reader = new ContentReader(bytes, chunk);
  const size = { x: reader.int32('x size'), y: reader.int32('y size'), z: reader.int32('z size') };
  reader.finish();
  if (![size.x, size.y, size.z].every((dimension) => dimension > 0 && dimension <= 256)) {
    invalid('SIZE dimensions must be integers between 1 and 256.');
  }
  return size;
}

function parseXyzi(bytes: Uint8Array, chunk: ParsedChunk, size: VoxelCoordinate): StoredVoxel[] {
  const reader = new ContentReader(bytes, chunk);
  const count = reader.int32('voxel count');
  if (count < 0) invalid('XYZI contains a negative voxel count.');
  reader.exactBytes(count * 4, 'voxel records');
  const voxels: StoredVoxel[] = [];
  const coordinates = new Set<number>();
  for (let index = 0; index < count; index += 1) {
    const x = reader.uint8(`voxel ${index} x`);
    const y = reader.uint8(`voxel ${index} y`);
    const z = reader.uint8(`voxel ${index} z`);
    const paletteIndex = reader.uint8(`voxel ${index} palette index`);
    if (x >= size.x || y >= size.y || z >= size.z) invalid(`XYZI voxel ${index} lies outside its SIZE chunk.`);
    if (paletteIndex === 0) invalid(`XYZI voxel ${index} uses reserved palette index 0.`);
    const key = x | (y << 8) | (z << 16);
    if (coordinates.has(key)) invalid('XYZI contains duplicate voxel coordinates.');
    coordinates.add(key);
    voxels.push({ x, y, z, paletteIndex });
  }
  reader.finish();
  return voxels;
}

function parseRgba(bytes: Uint8Array, chunk: ParsedChunk): RGB[] {
  if (chunk.contentEnd - chunk.contentStart !== 256 * 4) invalid('RGBA must contain exactly 256 colors.');
  return Array.from({ length: 256 }, (_, index) => {
    const offset = chunk.contentStart + index * 4;
    return { r: bytes[offset], g: bytes[offset + 1], b: bytes[offset + 2] };
  });
}

function parseIndexMap(bytes: Uint8Array, chunk: ParsedChunk): Uint8Array {
  // Despite an old extension-document typo describing int32 entries, MagicaVoxel
  // writes IMAP as 256 one-byte display-index -> stored-palette-index entries.
  if (chunk.contentEnd - chunk.contentStart !== 256) invalid('IMAP must contain exactly 256 palette-index bytes.');
  const mapping = bytes.slice(chunk.contentStart, chunk.contentEnd);
  const seen = new Uint8Array(256);
  for (const paletteIndex of mapping) {
    if (seen[paletteIndex]) invalid('IMAP must be a permutation of palette indices 0 through 255.');
    seen[paletteIndex] = 1;
  }
  return mapping;
}

function applyIndexMap(palette: RGB[], indexMap: Uint8Array | undefined): {
  palette: RGB[];
  paletteIndices: Uint8Array;
} {
  const paletteIndices = new Uint8Array(256);
  if (!indexMap) {
    for (let index = 1; index < 256; index += 1) paletteIndices[index] = index;
    return { palette: palette.slice(0, 255), paletteIndices };
  }

  const rgbaPalette = palette.length === 255 ? [...palette, { r: 0, g: 0, b: 0 }] : palette;
  const inverse = new Uint8Array(256);
  for (let displayIndex = 0; displayIndex < 256; displayIndex += 1) {
    inverse[indexMap[displayIndex]] = displayIndex;
  }
  const displayedPalette = Array.from({ length: 255 }, (_, displayIndex) => {
    // RGBA entry 0 represents palette index 1, so the index association wraps
    // palette index 0 to raw RGBA entry 255.
    const storedRgbaIndex = (indexMap[displayIndex] + 255) & 0xff;
    const color = rgbaPalette[storedRgbaIndex];
    if (!color) invalid(`IMAP display slot ${displayIndex + 1} references unavailable palette index ${indexMap[displayIndex]}.`);
    return color!;
  });
  for (let storedIndex = 1; storedIndex < 256; storedIndex += 1) {
    paletteIndices[storedIndex] = (inverse[storedIndex] + 1) & 0xff;
  }
  return { palette: displayedPalette, paletteIndices };
}

function defaultPalette(): RGB[] {
  const colors: RGB[] = [];
  const levels = [255, 204, 153, 102, 51, 0];
  for (const r of levels) {
    for (const g of levels) {
      for (const b of levels) {
        if (r || g || b) colors.push({ r, g, b });
      }
    }
  }
  const accents = [238, 221, 187, 170, 136, 119, 85, 68, 34, 17];
  colors.push(
    ...accents.map((r) => ({ r, g: 0, b: 0 })),
    ...accents.map((g) => ({ r: 0, g, b: 0 })),
    ...accents.map((b) => ({ r: 0, g: 0, b })),
    ...accents.map((channel) => ({ r: channel, g: channel, b: channel })),
  );
  return colors;
}

function multiplyMatrices(a: Matrix3, b: Matrix3): Matrix3 {
  const result: Matrix3 = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  for (let row = 0; row < 3; row += 1) {
    for (let column = 0; column < 3; column += 1) {
      result[row * 3 + column] = a[row * 3] * b[column]
        + a[row * 3 + 1] * b[3 + column]
        + a[row * 3 + 2] * b[6 + column];
    }
  }
  return result;
}

function applyMatrix(matrix: Matrix3, value: VoxelCoordinate): VoxelCoordinate {
  return {
    x: matrix[0] * value.x + matrix[1] * value.y + matrix[2] * value.z,
    y: matrix[3] * value.x + matrix[4] * value.y + matrix[5] * value.z,
    z: matrix[6] * value.x + matrix[7] * value.y + matrix[8] * value.z,
  };
}

function add(a: VoxelCoordinate, b: VoxelCoordinate): VoxelCoordinate {
  const result = { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
  if (![result.x, result.y, result.z].every(Number.isSafeInteger)) invalid('scene transforms exceed the supported integer range.');
  return result;
}

function compose(parent: Transform, child: Transform): Transform {
  return {
    matrix: multiplyMatrices(parent.matrix, child.matrix),
    translation: add(applyMatrix(parent.matrix, child.translation), parent.translation),
  };
}

function buildInstances(
  nodes: Map<number, SceneNode>,
  models: StoredModel[],
  layers: Map<number, Layer>,
): ModelInstance[] {
  if (!nodes.size) return models.map((_, modelId) => ({ modelId, transform: IDENTITY_TRANSFORM }));

  const referenced = new Set<number>();
  for (const node of nodes.values()) {
    if (node.kind === 'transform') referenced.add(node.child);
    if (node.kind === 'group') node.children.forEach((child) => referenced.add(child));
  }
  for (const child of referenced) {
    if (!nodes.has(child)) invalid(`scene node ${child} is referenced but missing.`);
  }
  const roots = [...nodes.keys()].filter((id) => !referenced.has(id)).sort((a, b) => a - b);
  if (!roots.length) invalid('the scene graph has no root node.');

  const instances: ModelInstance[] = [];
  const reached = new Set<number>();
  const visit = (id: number, parent: Transform, path: Set<number>, parentHidden: boolean) => {
    if (path.has(id)) invalid(`the scene graph contains a cycle at node ${id}.`);
    const node = nodes.get(id);
    if (!node) invalid(`scene node ${id} is referenced but missing.`);
    reached.add(id);
    const nextPath = new Set(path).add(id);
    if (node.kind === 'transform') {
      const layerHidden = node.layerId >= 0 && layers.get(node.layerId)?.hidden === true;
      visit(node.child, compose(parent, node.transform), nextPath, parentHidden || node.hidden || layerHidden);
    } else if (node.kind === 'group') {
      node.children.forEach((child) => visit(child, parent, nextPath, parentHidden));
    } else {
      if (!models[node.modelId]) invalid(`nSHP references missing model ${node.modelId}.`);
      if (!parentHidden) instances.push({ modelId: node.modelId, transform: parent });
    }
  };
  roots.forEach((root) => visit(root, IDENTITY_TRANSFORM, new Set(), false));
  if (reached.size !== nodes.size) invalid('the scene graph contains an unreachable cycle.');
  return instances;
}

function modelPivot(size: VoxelCoordinate): VoxelCoordinate {
  return { x: Math.floor(size.x / 2), y: Math.floor(size.y / 2), z: Math.floor(size.z / 2) };
}

function transformedVoxel(transform: Transform, voxel: VoxelCoordinate, pivot: VoxelCoordinate): VoxelCoordinate {
  // Scene-node transforms operate on model geometry relative to floor(SIZE / 2).
  // Transform cell centers so a negative row maps a unit cell to the correct
  // integer cell: floor(-(coordinate + 0.5)) = -coordinate - 1.
  const source = [voxel.x - pivot.x, voxel.y - pivot.y, voxel.z - pivot.z];
  const result = [0, 0, 0];
  for (let row = 0; row < 3; row += 1) {
    for (let column = 0; column < 3; column += 1) {
      const coefficient = transform.matrix[row * 3 + column];
      if (coefficient === 1) result[row] += source[column];
      else if (coefficient === -1) result[row] += -source[column] - 1;
    }
  }
  return add({ x: result[0], y: result[1], z: result[2] }, transform.translation);
}

function transformedBounds(
  transform: Transform,
  size: VoxelCoordinate,
  pivot: VoxelCoordinate,
): { min: VoxelCoordinate; max: VoxelCoordinate } {
  const min = { x: Number.POSITIVE_INFINITY, y: Number.POSITIVE_INFINITY, z: Number.POSITIVE_INFINITY };
  const max = { x: Number.NEGATIVE_INFINITY, y: Number.NEGATIVE_INFINITY, z: Number.NEGATIVE_INFINITY };
  for (const x of [0, size.x]) {
    for (const y of [0, size.y]) {
      for (const z of [0, size.z]) {
        const corner = add(applyMatrix(transform.matrix, {
          x: x - pivot.x,
          y: y - pivot.y,
          z: z - pivot.z,
        }), transform.translation);
        min.x = Math.min(min.x, corner.x);
        min.y = Math.min(min.y, corner.y);
        min.z = Math.min(min.z, corner.z);
        max.x = Math.max(max.x, corner.x);
        max.y = Math.max(max.y, corner.y);
        max.z = Math.max(max.z, corner.z);
      }
    }
  }
  return { min, max };
}

function parseStoredData(bytes: Uint8Array, chunks: ParsedChunk[]) {
  const models: StoredModel[] = [];
  const nodes = new Map<number, SceneNode>();
  const layers = new Map<number, Layer>();
  let pendingSize: VoxelCoordinate | undefined;
  let packCount: number | undefined;
  let palette: RGB[] | undefined;
  let indexMap: Uint8Array | undefined;

  for (const chunk of chunks) {
    if (chunk.id === 'PACK') {
      if (packCount !== undefined) invalid('the file contains more than one PACK chunk.');
      const reader = new ContentReader(bytes, chunk);
      packCount = reader.int32('model count');
      reader.finish();
      if (packCount <= 0) invalid('PACK model count must be greater than zero.');
    } else if (chunk.id === 'SIZE') {
      if (pendingSize) invalid('a SIZE chunk is missing its XYZI pair.');
      pendingSize = parseSize(bytes, chunk);
    } else if (chunk.id === 'XYZI') {
      if (!pendingSize) invalid('an XYZI chunk has no preceding SIZE chunk.');
      models.push({ size: pendingSize, voxels: parseXyzi(bytes, chunk, pendingSize) });
      pendingSize = undefined;
    } else if (chunk.id === 'RGBA') {
      if (palette) invalid('the file contains more than one RGBA chunk.');
      palette = parseRgba(bytes, chunk);
    } else if (chunk.id === 'IMAP') {
      if (indexMap) invalid('the file contains more than one IMAP chunk.');
      indexMap = parseIndexMap(bytes, chunk);
    } else if (chunk.id === 'LAYR') {
      const layer = parseLayer(bytes, chunk);
      if (layers.has(layer.id)) invalid(`layer id ${layer.id} is duplicated.`);
      layers.set(layer.id, layer);
    } else if (chunk.id === 'nTRN' || chunk.id === 'nGRP' || chunk.id === 'nSHP') {
      const node = chunk.id === 'nTRN'
        ? parseTransformNode(bytes, chunk)
        : chunk.id === 'nGRP'
          ? parseGroupNode(bytes, chunk)
          : parseShapeNode(bytes, chunk);
      if (nodes.has(node.id)) invalid(`scene node id ${node.id} is duplicated.`);
      nodes.set(node.id, node);
    }
  }
  if (pendingSize) invalid('a SIZE chunk is missing its XYZI pair.');
  if (!models.length) invalid('the file contains no SIZE/XYZI model.');
  if (packCount !== undefined && packCount !== models.length) {
    invalid(`PACK declares ${packCount} models, but ${models.length} SIZE/XYZI pairs were found.`);
  }
  return { models, nodes, layers, palette: palette ?? defaultPalette(), indexMap };
}

/** Decode a MagicaVoxel VOX 150 or 200 payload into VoxelMill's Y-up voxel model. */
export function decodeVox(input: ArrayBuffer | Uint8Array, sourceName = 'model.vox'): VoxelModel {
  const bytes = bytesFrom(input);
  const { chunks, version } = parseChunks(bytes);
  const { models, nodes, layers, palette: storedPalette, indexMap } = parseStoredData(bytes, chunks);
  const { palette: sourcePalette, paletteIndices } = applyIndexMap(storedPalette, indexMap);
  const instances = buildInstances(nodes, models, layers);
  const usesScenePivots = nodes.size > 0;

  const boundsMin = { x: Number.POSITIVE_INFINITY, y: Number.POSITIVE_INFINITY, z: Number.POSITIVE_INFINITY };
  const boundsMax = { x: Number.NEGATIVE_INFINITY, y: Number.NEGATIVE_INFINITY, z: Number.NEGATIVE_INFINITY };
  const rawVoxels: StoredVoxel[] = [];
  for (const instance of instances) {
    const model = models[instance.modelId];
    // Legacy model-only VOX files have no scene graph and keep their historical
    // corner-origin coordinates. Pivot-relative coordinates apply only to scene instances.
    const pivot = usesScenePivots ? modelPivot(model.size) : { x: 0, y: 0, z: 0 };
    const bounds = transformedBounds(instance.transform, model.size, pivot);
    boundsMin.x = Math.min(boundsMin.x, bounds.min.x);
    boundsMin.y = Math.min(boundsMin.y, bounds.min.y);
    boundsMin.z = Math.min(boundsMin.z, bounds.min.z);
    boundsMax.x = Math.max(boundsMax.x, bounds.max.x);
    boundsMax.y = Math.max(boundsMax.y, bounds.max.y);
    boundsMax.z = Math.max(boundsMax.z, bounds.max.z);
    for (const voxel of model.voxels) {
      const paletteIndex = paletteIndices[voxel.paletteIndex];
      // A stored color associated with IMAP's final non-display slot wraps to
      // palette index zero, matching MagicaVoxel's empty-voxel convention.
      if (paletteIndex === 0) continue;
      rawVoxels.push({
        ...transformedVoxel(instance.transform, voxel, pivot),
        paletteIndex,
      });
    }
  }

  if (!instances.length) {
    boundsMin.x = boundsMin.y = boundsMin.z = 0;
    boundsMax.x = boundsMax.y = boundsMax.z = 1;
  }
  const shift = {
    x: Math.max(0, -boundsMin.x),
    y: Math.max(0, -boundsMin.y),
    z: Math.max(0, -boundsMin.z),
  };
  const voxSize = { x: boundsMax.x + shift.x, y: boundsMax.y + shift.y, z: boundsMax.z + shift.z };
  if (![voxSize.x, voxSize.y, voxSize.z].every((dimension) => Number.isSafeInteger(dimension)
    && dimension > 0 && dimension <= VOXEL_COORDINATE_LIMIT)) {
    invalid(`the transformed scene does not fit the ${VOXEL_COORDINATE_LIMIT}×${VOXEL_COORDINATE_LIMIT}×${VOXEL_COORDINATE_LIMIT} coordinate contract.`);
  }

  const combined = new Map<string, StoredVoxel>();
  for (const voxel of rawVoxels) {
    const shifted = { ...voxel, x: voxel.x + shift.x, y: voxel.y + shift.y, z: voxel.z + shift.z };
    if (!isSupportedVoxelCoordinate(shifted)
      || shifted.x >= voxSize.x || shifted.y >= voxSize.y || shifted.z >= voxSize.z) {
      invalid('a transformed voxel lies outside the supported coordinate contract.');
    }
    const key = `${shifted.x}:${shifted.y}:${shifted.z}`;
    // MagicaVoxel changed overlap priority in version 200: lower instance
    // numbers win, whereas version 150 gives later/higher instances priority.
    if (version === 150 || !combined.has(key)) combined.set(key, shifted);
  }

  let maxPaletteIndex = 1;
  for (const voxel of combined.values()) maxPaletteIndex = Math.max(maxPaletteIndex, voxel.paletteIndex);
  const palette = sourcePalette.slice(0, maxPaletteIndex);
  const voxels: Voxel[] = [...combined.values()].map((voxel) => {
    const colorIndex = voxel.paletteIndex - 1;
    const color = palette[colorIndex];
    if (!color) invalid(`palette index ${voxel.paletteIndex} has no color.`);
    // MagicaVoxel is Z-up; VoxelMill is Y-up.
    return { x: voxel.x, y: voxel.z, z: voxel.y, colorIndex, ...color };
  }).sort((a, b) => a.z - b.z || a.y - b.y || a.x - b.x || a.colorIndex - b.colorIndex);

  return {
    sourceName,
    voxelSize: 1,
    size: { x: voxSize.x, y: voxSize.z, z: voxSize.y },
    palette,
    voxels,
  };
}
