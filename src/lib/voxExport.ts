import type { RGB, VoxelModel } from '../types';
import { isSupportedVoxelCoordinate, MAX_VOXEL_COORDINATE, VOXEL_COORDINATE_LIMIT } from './voxelIndex';

const encoder = new TextEncoder();

function writeString(view: DataView, offset: number, value: string) {
  new Uint8Array(view.buffer, offset, value.length).set(encoder.encode(value));
}

function chunk(id: string, content: Uint8Array, children = new Uint8Array()): Uint8Array {
  const bytes = new Uint8Array(12 + content.length + children.length);
  const view = new DataView(bytes.buffer);
  writeString(view, 0, id);
  view.setUint32(4, content.length, true);
  view.setUint32(8, children.length, true);
  bytes.set(content, 12);
  bytes.set(children, 12 + content.length);
  return bytes;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const bytes = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.length;
  }
  return bytes;
}

function int32(value: number): Uint8Array {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setInt32(0, value, true);
  return bytes;
}

function voxString(value: string): Uint8Array {
  const encoded = encoder.encode(value);
  return concat([int32(encoded.length), encoded]);
}

function dictionary(values: Record<string, string> = {}): Uint8Array {
  return concat([int32(Object.keys(values).length), ...Object.entries(values).flatMap(([key, value]) => [voxString(key), voxString(value)])]);
}

function makePalette(colors: RGB[]): Uint8Array {
  const content = new Uint8Array(256 * 4);
  for (let i = 0; i < 255; i += 1) {
    const color = colors[i] ?? colors[colors.length - 1] ?? { r: 255, g: 255, b: 255 };
    const offset = i * 4;
    content[offset] = color.r;
    content[offset + 1] = color.g;
    content[offset + 2] = color.b;
    content[offset + 3] = 255;
  }
  return content;
}

interface VoxChunk {
  origin: { x: number; y: number; z: number };
  size: { x: number; y: number; z: number };
  voxels: Array<{ x: number; y: number; z: number; colorIndex: number }>;
}

function partitionModel(model: VoxelModel): VoxChunk[] {
  const chunks = new Map<string, VoxChunk>();
  const storedSize = { x: model.size.x, y: model.size.z, z: model.size.y };

  // SIZE is limited to 256 per axis, so tile the complete declared volume,
  // including empty cells. Empty trailing tiles carry extents without adding
  // fake occupancy, and the editor's 1024-axis limit bounds this to 64 chunks.
  for (let z = 0; z < storedSize.z; z += 256) {
    for (let y = 0; y < storedSize.y; y += 256) {
      for (let x = 0; x < storedSize.x; x += 256) {
        const origin = { x, y, z };
        chunks.set(`${x},${y},${z}`, {
          origin,
          size: {
            x: Math.min(256, storedSize.x - x),
            y: Math.min(256, storedSize.y - y),
            z: Math.min(256, storedSize.z - z),
          },
          voxels: [],
        });
      }
    }
  }

  for (const voxel of model.voxels) {
    // MagicaVoxel uses Z-up. The preview/source model is Y-up, so swap Y and Z here.
    const coordinate = { x: voxel.x, y: voxel.z, z: voxel.y };
    const origin = {
      x: Math.floor(coordinate.x / 256) * 256,
      y: Math.floor(coordinate.y / 256) * 256,
      z: Math.floor(coordinate.z / 256) * 256,
    };
    const key = `${origin.x},${origin.y},${origin.z}`;
    const entry = chunks.get(key)!;
    const local = { x: coordinate.x - origin.x, y: coordinate.y - origin.y, z: coordinate.z - origin.z };
    entry.voxels.push({ ...local, colorIndex: voxel.colorIndex });
  }
  return [...chunks.values()]
    .sort((a, b) => a.origin.z - b.origin.z || a.origin.y - b.origin.y || a.origin.x - b.origin.x)
    .map((part) => ({
      ...part,
      voxels: [...part.voxels].sort((a, b) => a.z - b.z || a.y - b.y || a.x - b.x || a.colorIndex - b.colorIndex),
    }));
}

function modelChunks(part: VoxChunk): Uint8Array[] {
  const size = new Uint8Array(12);
  const sizeView = new DataView(size.buffer);
  sizeView.setUint32(0, part.size.x, true);
  sizeView.setUint32(4, part.size.y, true);
  sizeView.setUint32(8, part.size.z, true);

  const xyzi = new Uint8Array(4 + part.voxels.length * 4);
  const xyziView = new DataView(xyzi.buffer);
  xyziView.setUint32(0, part.voxels.length, true);
  part.voxels.forEach((voxel, index) => {
    const offset = 4 + index * 4;
    xyzi[offset] = voxel.x;
    xyzi[offset + 1] = voxel.y;
    xyzi[offset + 2] = voxel.z;
    xyzi[offset + 3] = voxel.colorIndex + 1;
  });
  return [chunk('SIZE', size), chunk('XYZI', xyzi)];
}

function sceneGraph(parts: VoxChunk[]): Uint8Array[] {
  const rootTransform = chunk('nTRN', concat([
    int32(0), dictionary(), int32(1), int32(-1), int32(-1), int32(1), dictionary(),
  ]));
  const transformIds = parts.map((_, index) => 2 + index * 2);
  const rootGroup = chunk('nGRP', concat([int32(1), dictionary(), int32(transformIds.length), ...transformIds.map(int32)]));
  const nodes = parts.flatMap((part, index) => {
    const transformId = transformIds[index];
    const shapeId = transformId + 1;
    // Scene transforms place the model's center pivot, floor(SIZE / 2), in
    // world space. Translating to origin + pivot preserves the chunk's original
    // corner-origin coordinates in MagicaVoxel and other conforming readers.
    const translation = `${part.origin.x + Math.floor(part.size.x / 2)} ${part.origin.y + Math.floor(part.size.y / 2)} ${part.origin.z + Math.floor(part.size.z / 2)}`;
    return [
      chunk('nTRN', concat([
        int32(transformId), dictionary(), int32(shapeId), int32(-1), int32(-1), int32(1), dictionary({ _t: translation }),
      ])),
      chunk('nSHP', concat([int32(shapeId), dictionary(), int32(1), int32(index), dictionary()])),
    ];
  });
  return [rootTransform, rootGroup, ...nodes];
}

function validateModelCoordinates(model: VoxelModel) {
  if (![model.size.x, model.size.y, model.size.z]
    .every((dimension) => Number.isInteger(dimension) && dimension > 0 && dimension <= VOXEL_COORDINATE_LIMIT)) {
    throw new RangeError(`VOX model dimensions must be integers between 1 and ${VOXEL_COORDINATE_LIMIT}.`);
  }
  if (model.palette.length < 1 || model.palette.length > 255) {
    throw new RangeError('VOX palettes must contain between 1 and 255 colors.');
  }
  for (const color of model.palette) {
    if (![color.r, color.g, color.b].every((channel) => Number.isInteger(channel) && channel >= 0 && channel <= 255)) {
      throw new RangeError('VOX palette channels must be integers between 0 and 255.');
    }
  }
  const coordinates = new Set<string>();
  for (const voxel of model.voxels) {
    if (!isSupportedVoxelCoordinate(voxel)
      || voxel.x >= model.size.x || voxel.y >= model.size.y || voxel.z >= model.size.z) {
      throw new RangeError(`VOX voxel coordinates must be inside the model and between 0 and ${MAX_VOXEL_COORDINATE}.`);
    }
    if (!Number.isInteger(voxel.colorIndex) || voxel.colorIndex < 0 || voxel.colorIndex >= model.palette.length) {
      throw new RangeError('VOX voxel color indices must reference an existing palette color.');
    }
    const key = `${voxel.x}:${voxel.y}:${voxel.z}`;
    if (coordinates.has(key)) throw new RangeError('VOX models cannot contain duplicate voxel coordinates.');
    coordinates.add(key);
  }
}

export function encodeVox(model: VoxelModel): Uint8Array {
  validateModelCoordinates(model);
  const parts = partitionModel(model);
  const needsSceneGraph = parts.length > 1
    || parts.some((part) => part.origin.x !== 0 || part.origin.y !== 0 || part.origin.z !== 0);
  const childrenParts = [
    ...(parts.length > 1 ? [chunk('PACK', int32(parts.length))] : []),
    ...parts.flatMap(modelChunks),
    chunk('RGBA', makePalette(model.palette)),
    ...(needsSceneGraph ? sceneGraph(parts) : []),
  ];

  const children = concat(childrenParts);
  const main = chunk('MAIN', new Uint8Array(), children);
  const output = new Uint8Array(8 + main.length);
  const view = new DataView(output.buffer);
  writeString(view, 0, 'VOX ');
  view.setUint32(4, 150, true);
  output.set(main, 8);
  return output;
}

export function downloadVox(model: VoxelModel) {
  const bytes = encodeVox(model);
  const blob = new Blob([bytes], { type: 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  const baseName = model.sourceName.replace(/\.[^.]+$/, '').replace(/[^a-z0-9_-]+/gi, '-');
  anchor.href = url;
  anchor.download = `${baseName || 'model'}-${model.size.x}x${model.size.y}x${model.size.z}.vox`;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
