import type { FillMode, MaterialColorMode, SamplingQuality, VoxelModel, VoxelizeOptions } from '../types';

const MAGIC = [0x56, 0x58, 0x4d, 0x50] as const; // VXMP
const VERSION = 1;
const HEADER_BYTES = 16;
const VOXEL_BYTES = 7;

export interface VoxelMillProject {
  model: VoxelModel;
  options: VoxelizeOptions;
}

interface ProjectManifest {
  sourceName: string;
  voxelSize: number;
  size: VoxelModel['size'];
  options: VoxelizeOptions;
}

const validChoice = <T extends string>(value: unknown, choices: readonly T[]): value is T =>
  typeof value === 'string' && choices.includes(value as T);

function validateManifest(value: unknown): ProjectManifest {
  if (!value || typeof value !== 'object') throw new Error('The VoxelMill project manifest is missing.');
  const manifest = value as Partial<ProjectManifest>;
  const size = manifest.size;
  const options = manifest.options;
  if (typeof manifest.sourceName !== 'string' || !manifest.sourceName
    || typeof manifest.voxelSize !== 'number' || !Number.isFinite(manifest.voxelSize) || manifest.voxelSize <= 0
    || !size || ![size.x, size.y, size.z].every((dimension) => Number.isInteger(dimension) && dimension > 0 && dimension <= 65535)
    || !options
    || !Number.isInteger(options.resolution) || options.resolution < 1
    || !Number.isInteger(options.paletteSize) || options.paletteSize < 1 || options.paletteSize > 255
    || typeof options.alphaThreshold !== 'number' || options.alphaThreshold < 0 || options.alphaThreshold > 1
    || !validChoice<FillMode>(options.fillMode, ['surface', 'solid'])
    || !validChoice<SamplingQuality>(options.samplingQuality, ['draft', 'balanced', 'high'])
    || !validChoice<MaterialColorMode>(options.materialColorMode, ['baseColor', 'appearance'])) {
    throw new Error('The VoxelMill project manifest contains invalid values.');
  }
  return manifest as ProjectManifest;
}

export function encodeVoxelMillProject({ model, options }: VoxelMillProject): ArrayBuffer {
  if (!model.palette.length || model.palette.length > 255) throw new Error('Projects require between 1 and 255 palette colors.');
  if (!model.palette.every((color) => [color.r, color.g, color.b].every((channel) => Number.isInteger(channel) && channel >= 0 && channel <= 255))) {
    throw new Error('The project palette contains an invalid RGB value.');
  }
  if (model.voxels.length > 0xffffffff) throw new Error('The project contains too many voxels.');
  const manifest = validateManifest({
    sourceName: model.sourceName,
    voxelSize: model.voxelSize,
    size: model.size,
    options,
  } satisfies ProjectManifest);
  const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest));
  const length = HEADER_BYTES + manifestBytes.length + model.palette.length * 3 + model.voxels.length * VOXEL_BYTES;
  const bytes = new Uint8Array(length);
  const view = new DataView(bytes.buffer);
  bytes.set(MAGIC, 0);
  view.setUint16(4, VERSION, true);
  view.setUint32(6, manifestBytes.length, true);
  view.setUint16(10, model.palette.length, true);
  view.setUint32(12, model.voxels.length, true);
  let cursor = HEADER_BYTES;
  bytes.set(manifestBytes, cursor);
  cursor += manifestBytes.length;
  for (const color of model.palette) {
    bytes[cursor++] = color.r;
    bytes[cursor++] = color.g;
    bytes[cursor++] = color.b;
  }
  const coordinates = new Set<string>();
  for (const voxel of model.voxels) {
    if (![voxel.x, voxel.y, voxel.z, voxel.colorIndex].every(Number.isInteger)
      || voxel.x < 0 || voxel.y < 0 || voxel.z < 0
      || voxel.x >= model.size.x || voxel.y >= model.size.y || voxel.z >= model.size.z
      || voxel.colorIndex < 0 || voxel.colorIndex >= model.palette.length) {
      throw new Error('The project contains an invalid voxel coordinate or palette index.');
    }
    const coordinate = `${voxel.x}:${voxel.y}:${voxel.z}`;
    if (coordinates.has(coordinate)) throw new Error('The project contains duplicate voxel coordinates.');
    coordinates.add(coordinate);
    view.setUint16(cursor, voxel.x, true);
    view.setUint16(cursor + 2, voxel.y, true);
    view.setUint16(cursor + 4, voxel.z, true);
    bytes[cursor + 6] = voxel.colorIndex;
    cursor += VOXEL_BYTES;
  }
  return bytes.buffer;
}

export function decodeVoxelMillProject(buffer: ArrayBuffer): VoxelMillProject {
  if (buffer.byteLength < HEADER_BYTES) throw new Error('This file is too small to be a VoxelMill project.');
  const bytes = new Uint8Array(buffer);
  if (!MAGIC.every((value, index) => bytes[index] === value)) throw new Error('This is not a VoxelMill project file.');
  const view = new DataView(buffer);
  const version = view.getUint16(4, true);
  if (version !== VERSION) throw new Error(`VoxelMill project version ${version} is not supported.`);
  const manifestLength = view.getUint32(6, true);
  const paletteCount = view.getUint16(10, true);
  const voxelCount = view.getUint32(12, true);
  const expectedLength = HEADER_BYTES + manifestLength + paletteCount * 3 + voxelCount * VOXEL_BYTES;
  if (!paletteCount || paletteCount > 255 || expectedLength !== buffer.byteLength) throw new Error('The VoxelMill project is truncated or corrupt.');
  let cursor = HEADER_BYTES;
  let manifestValue: unknown;
  try {
    manifestValue = JSON.parse(new TextDecoder().decode(bytes.subarray(cursor, cursor + manifestLength)));
  } catch {
    throw new Error('The VoxelMill project manifest could not be read.');
  }
  const manifest = validateManifest(manifestValue);
  cursor += manifestLength;
  const palette = Array.from({ length: paletteCount }, () => ({
    r: bytes[cursor++],
    g: bytes[cursor++],
    b: bytes[cursor++],
  }));
  const voxels = [];
  const coordinates = new Set<string>();
  for (let index = 0; index < voxelCount; index += 1) {
    const x = view.getUint16(cursor, true);
    const y = view.getUint16(cursor + 2, true);
    const z = view.getUint16(cursor + 4, true);
    const colorIndex = bytes[cursor + 6];
    cursor += VOXEL_BYTES;
    if (x >= manifest.size.x || y >= manifest.size.y || z >= manifest.size.z || colorIndex >= palette.length) {
      throw new Error('The VoxelMill project contains invalid voxel data.');
    }
    const coordinate = `${x}:${y}:${z}`;
    if (coordinates.has(coordinate)) throw new Error('The VoxelMill project contains duplicate voxel coordinates.');
    coordinates.add(coordinate);
    voxels.push({ x, y, z, colorIndex, ...palette[colorIndex] });
  }
  return {
    options: manifest.options,
    model: {
      voxels,
      palette,
      size: manifest.size,
      voxelSize: manifest.voxelSize,
      sourceName: manifest.sourceName,
    },
  };
}

export function downloadVoxelMillProject(project: VoxelMillProject) {
  const blob = new Blob([encodeVoxelMillProject(project)], { type: 'application/x-voxelmill-project' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  const baseName = project.model.sourceName.replace(/\.[^.]+$/u, '').replace(/[^a-z0-9_-]+/giu, '-');
  anchor.download = `${baseName || 'model'}.voxelmill`;
  anchor.hidden = true;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
