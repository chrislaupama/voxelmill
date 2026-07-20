import { describe, expect, it } from 'vitest';
import type { VoxelModel } from '../types';
import { encodeVox } from './voxExport';

const decoder = new TextDecoder();

interface ParsedChunk {
  id: string;
  content: Uint8Array;
  children: ParsedChunk[];
  end: number;
}

function readUint32(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0, true);
}

function parseChunk(bytes: Uint8Array, offset: number): ParsedChunk {
  const id = decoder.decode(bytes.subarray(offset, offset + 4));
  const contentLength = readUint32(bytes, offset + 4);
  const childrenLength = readUint32(bytes, offset + 8);
  const contentStart = offset + 12;
  const childrenStart = contentStart + contentLength;
  const end = childrenStart + childrenLength;
  if (end > bytes.length) throw new Error(`Chunk ${id} exceeds the VOX payload.`);
  const children = [];
  for (let cursor = childrenStart; cursor < end;) {
    const child = parseChunk(bytes, cursor);
    children.push(child);
    cursor = child.end;
  }
  return { id, content: bytes.slice(contentStart, childrenStart), children, end };
}

function parseVox(bytes: Uint8Array): ParsedChunk[] {
  if (decoder.decode(bytes.subarray(0, 4)) !== 'VOX ') throw new Error('Missing VOX signature.');
  const main = parseChunk(bytes, 8);
  if (main.id !== 'MAIN' || main.end !== bytes.length) throw new Error('Invalid MAIN chunk.');
  return main.children;
}

function int32Reader(content: Uint8Array) {
  const view = new DataView(content.buffer, content.byteOffset, content.byteLength);
  let cursor = 0;
  const int = () => {
    const value = view.getInt32(cursor, true);
    cursor += 4;
    return value;
  };
  const string = () => {
    const length = int();
    const value = decoder.decode(content.subarray(cursor, cursor + length));
    cursor += length;
    return value;
  };
  const dictionary = () => Object.fromEntries(Array.from({ length: int() }, () => [string(), string()]));
  return { int, dictionary };
}

function transformTranslations(chunks: ParsedChunk[]): string[] {
  return chunks.filter((entry) => entry.id === 'nTRN').flatMap((entry) => {
    const reader = int32Reader(entry.content);
    reader.int();
    reader.dictionary();
    reader.int();
    reader.int();
    reader.int();
    const frames = reader.int();
    return Array.from({ length: frames }, () => reader.dictionary()._t).filter((value): value is string => Boolean(value));
  });
}

function externallyComposedWorldVoxels(chunks: ParsedChunk[]): Array<{ x: number; y: number; z: number }> {
  const sizes = chunks.filter((entry) => entry.id === 'SIZE').map((entry) => ({
    x: readUint32(entry.content, 0),
    y: readUint32(entry.content, 4),
    z: readUint32(entry.content, 8),
  }));
  const modelVoxels = chunks.filter((entry) => entry.id === 'XYZI').map((entry) => {
    const count = readUint32(entry.content, 0);
    return Array.from({ length: count }, (_, index) => {
      const offset = 4 + index * 4;
      return { x: entry.content[offset], y: entry.content[offset + 1], z: entry.content[offset + 2] };
    });
  });
  const translations = transformTranslations(chunks).map((value) => {
    const [x, y, z] = value.split(' ').map(Number);
    return { x, y, z };
  });

  if (sizes.length !== modelVoxels.length || sizes.length !== translations.length) {
    throw new Error('Scene models and transforms do not pair one-to-one.');
  }
  return modelVoxels.flatMap((voxels, modelIndex) => {
    const size = sizes[modelIndex];
    const translation = translations[modelIndex];
    const pivot = { x: Math.floor(size.x / 2), y: Math.floor(size.y / 2), z: Math.floor(size.z / 2) };
    return voxels.map((voxel) => ({
      x: voxel.x - pivot.x + translation.x,
      y: voxel.y - pivot.y + translation.y,
      z: voxel.z - pivot.z + translation.z,
    }));
  });
}

function modelAt(coordinate: { x: number; y: number; z: number }, size: VoxelModel['size']): VoxelModel {
  return {
    sourceName: 'boundary.glb', voxelSize: 1, size,
    palette: [{ r: 200, g: 100, b: 50 }],
    voxels: [{ ...coordinate, r: 200, g: 100, b: 50, colorIndex: 0 }],
  };
}

describe('encodeVox', () => {
  it('writes a MagicaVoxel 150 file with correctly oriented model chunks', () => {
    const model: VoxelModel = {
      sourceName: 'test.glb',
      voxelSize: 1,
      size: { x: 2, y: 3, z: 4 },
      palette: [{ r: 12, g: 34, b: 56 }],
      voxels: [{ x: 1, y: 2, z: 3, r: 12, g: 34, b: 56, colorIndex: 0 }],
    };
    const bytes = encodeVox(model);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const chunks = parseVox(bytes);

    expect(view.getUint32(4, true)).toBe(150);
    expect(chunks.map((entry) => entry.id)).toEqual(['SIZE', 'XYZI', 'RGBA']);
    const size = chunks[0].content;
    expect([readUint32(size, 0), readUint32(size, 4), readUint32(size, 8)]).toEqual([2, 4, 3]);
    expect([...chunks[1].content]).toEqual([1, 0, 0, 0, 1, 3, 2, 1]);
    expect([...chunks[2].content.slice(0, 4)]).toEqual([12, 34, 56, 255]);
  });

  it('partitions coordinates above 255 into positioned scene models', () => {
    const model: VoxelModel = {
      sourceName: 'large.glb', voxelSize: 1, size: { x: 301, y: 1, z: 1 },
      palette: [{ r: 200, g: 100, b: 50 }],
      voxels: [
        { x: 0, y: 0, z: 0, r: 200, g: 100, b: 50, colorIndex: 0 },
        { x: 300, y: 0, z: 0, r: 200, g: 100, b: 50, colorIndex: 0 },
      ],
    };
    const chunks = parseVox(encodeVox(model));
    const pack = chunks.find((entry) => entry.id === 'PACK');

    expect(pack && readUint32(pack.content, 0)).toBe(2);
    expect(chunks.filter((entry) => entry.id === 'SIZE')).toHaveLength(2);
    expect(transformTranslations(chunks)).toEqual(['128 0 0', '278 0 0']);
    // This independently composes the raw VOX model pivot and transform, rather
    // than relying on VoxelMill's importer to agree with its own exporter.
    expect(externallyComposedWorldVoxels(chunks)).toEqual([
      { x: 0, y: 0, z: 0 },
      { x: 300, y: 0, z: 0 },
    ]);
  });

  it.each([
    {
      source: { x: 300, y: 0, z: 0 }, size: { x: 301, y: 1, z: 1 }, local: [44, 0, 0],
      translations: ['128 0 0', '278 0 0'],
    },
    {
      source: { x: 0, y: 300, z: 0 }, size: { x: 1, y: 301, z: 1 }, local: [0, 0, 44],
      translations: ['0 0 128', '0 0 278'],
    },
    {
      source: { x: 0, y: 0, z: 300 }, size: { x: 1, y: 1, z: 301 }, local: [0, 44, 0],
      translations: ['0 128 0', '0 278 0'],
    },
  ])('preserves the full declared extent for a sparse model at $source', ({ source, size, local, translations }) => {
    const chunks = parseVox(encodeVox(modelAt(source, size)));
    const xyzi = chunks.find((entry) => entry.id === 'XYZI' && readUint32(entry.content, 0) > 0);
    const pack = chunks.find((entry) => entry.id === 'PACK');

    expect(pack && readUint32(pack.content, 0)).toBe(2);
    expect(xyzi && [...xyzi.content.slice(4, 7)]).toEqual(local);
    expect(transformTranslations(chunks)).toEqual(translations);
    expect(externallyComposedWorldVoxels(chunks)).toEqual([{
      x: source.x,
      y: source.z,
      z: source.y,
    }]);
  });

  it('keeps the maximum supported coordinate exact across chunk boundaries', () => {
    const chunks = parseVox(encodeVox(modelAt({ x: 1023, y: 1023, z: 1023 }, { x: 1024, y: 1024, z: 1024 })));
    const xyzi = chunks.find((entry) => entry.id === 'XYZI' && readUint32(entry.content, 0) > 0);
    const pack = chunks.find((entry) => entry.id === 'PACK');

    expect(pack && readUint32(pack.content, 0)).toBe(64);
    expect(xyzi && [...xyzi.content.slice(4, 7)]).toEqual([255, 255, 255]);
    expect(transformTranslations(chunks)).toContain('896 896 896');
    expect(externallyComposedWorldVoxels(chunks)).toEqual([{ x: 1023, y: 1023, z: 1023 }]);
  });

  it('encodes trailing empty space as empty scene tiles without adding voxel occupancy', () => {
    const model = modelAt({ x: 0, y: 0, z: 0 }, { x: 700, y: 5, z: 7 });
    const chunks = parseVox(encodeVox(model));
    const sizes = chunks.filter((entry) => entry.id === 'SIZE').map((entry) => [
      readUint32(entry.content, 0),
      readUint32(entry.content, 4),
      readUint32(entry.content, 8),
    ]);
    const voxelCounts = chunks.filter((entry) => entry.id === 'XYZI')
      .map((entry) => readUint32(entry.content, 0));

    expect(sizes).toEqual([[256, 7, 5], [256, 7, 5], [188, 7, 5]]);
    expect(voxelCounts).toEqual([1, 0, 0]);
    expect(transformTranslations(chunks)).toEqual(['128 3 2', '384 3 2', '606 3 2']);
    expect(externallyComposedWorldVoxels(chunks)).toEqual([{ x: 0, y: 0, z: 0 }]);
  });

  it('writes byte-identical XYZI chunks regardless of input voxel array order', () => {
    const model: VoxelModel = {
      sourceName: 'deterministic.glb', voxelSize: 1, size: { x: 300, y: 3, z: 4 },
      palette: [{ r: 200, g: 100, b: 50 }],
      voxels: [
        { x: 299, y: 2, z: 3, r: 200, g: 100, b: 50, colorIndex: 0 },
        { x: 2, y: 0, z: 1, r: 200, g: 100, b: 50, colorIndex: 0 },
        { x: 1, y: 2, z: 0, r: 200, g: 100, b: 50, colorIndex: 0 },
        { x: 280, y: 1, z: 2, r: 200, g: 100, b: 50, colorIndex: 0 },
      ],
    };

    expect(encodeVox({ ...model, voxels: [...model.voxels].reverse() })).toEqual(encodeVox(model));
  });

  it('rejects dimensions and coordinates outside the editor coordinate contract', () => {
    expect(() => encodeVox(modelAt({ x: 0, y: 0, z: 0 }, { x: 1025, y: 1, z: 1 }))).toThrow('dimensions');
    expect(() => encodeVox(modelAt({ x: 1024, y: 0, z: 0 }, { x: 1024, y: 1, z: 1 }))).toThrow('coordinates');
  });

  it('rejects palettes, color references, and duplicate coordinates that cannot round-trip safely', () => {
    const valid = modelAt({ x: 0, y: 0, z: 0 }, { x: 1, y: 1, z: 1 });
    expect(() => encodeVox({ ...valid, palette: [] })).toThrow(/palettes/u);
    expect(() => encodeVox({ ...valid, palette: [{ r: 256, g: 0, b: 0 }] })).toThrow(/channels/u);
    expect(() => encodeVox({
      ...valid,
      voxels: [{ ...valid.voxels[0], colorIndex: 1 }],
    })).toThrow(/color indices/u);
    expect(() => encodeVox({
      ...valid,
      voxels: [...valid.voxels, { ...valid.voxels[0] }],
    })).toThrow(/duplicate voxel coordinates/u);
  });
});
