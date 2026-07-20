import { describe, expect, it } from 'vitest';
import type { RGB, VoxelModel } from '../types';
import { encodeVox } from './voxExport';
import { decodeVox, VoxImportError } from './voxImport';

const encoder = new TextEncoder();

function concat(parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((length, part) => length + part.length, 0));
  let cursor = 0;
  for (const part of parts) {
    result.set(part, cursor);
    cursor += part.length;
  }
  return result;
}

function int32(value: number): Uint8Array {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setInt32(0, value, true);
  return bytes;
}

function voxString(value: string): Uint8Array {
  const bytes = encoder.encode(value);
  return concat([int32(bytes.length), bytes]);
}

function dictionary(values: Record<string, string> = {}): Uint8Array {
  return concat([
    int32(Object.keys(values).length),
    ...Object.entries(values).flatMap(([key, value]) => [voxString(key), voxString(value)]),
  ]);
}

function chunk(id: string, content = new Uint8Array(), children = new Uint8Array()): Uint8Array {
  const result = new Uint8Array(12 + content.length + children.length);
  result.set(encoder.encode(id), 0);
  const view = new DataView(result.buffer);
  view.setUint32(4, content.length, true);
  view.setUint32(8, children.length, true);
  result.set(content, 12);
  result.set(children, 12 + content.length);
  return result;
}

function voxFile(children: Uint8Array[], version: 150 | 200 = 150): Uint8Array {
  const main = chunk('MAIN', new Uint8Array(), concat(children));
  const result = new Uint8Array(8 + main.length);
  result.set(encoder.encode('VOX '), 0);
  new DataView(result.buffer).setUint32(4, version, true);
  result.set(main, 8);
  return result;
}

function size(x: number, y: number, z: number): Uint8Array {
  return chunk('SIZE', concat([int32(x), int32(y), int32(z)]));
}

function xyzi(voxels: Array<{ x: number; y: number; z: number; color: number }>): Uint8Array {
  return chunk('XYZI', concat([
    int32(voxels.length),
    Uint8Array.from(voxels.flatMap((voxel) => [voxel.x, voxel.y, voxel.z, voxel.color])),
  ]));
}

function rgba(colors: RGB[]): Uint8Array {
  const content = new Uint8Array(256 * 4);
  for (let index = 0; index < 256; index += 1) {
    const color = colors[index] ?? colors[colors.length - 1] ?? { r: 255, g: 255, b: 255 };
    content.set([color.r, color.g, color.b, 255], index * 4);
  }
  return chunk('RGBA', content);
}

function imap(overrides: Record<number, number> = {}): Uint8Array {
  const mapping = Uint8Array.from({ length: 256 }, (_, index) => index === 255 ? 0 : index + 1);
  for (const [displayIndex, storedIndex] of Object.entries(overrides)) {
    mapping[Number(displayIndex)] = storedIndex;
  }
  return chunk('IMAP', mapping);
}

function transform(
  id: number,
  child: number,
  frame: Record<string, string> = {},
  attributes: Record<string, string> = {},
  layerId = -1,
): Uint8Array {
  return chunk('nTRN', concat([
    int32(id), dictionary(attributes), int32(child), int32(-1), int32(layerId), int32(1), dictionary(frame),
  ]));
}

function group(id: number, children: number[]): Uint8Array {
  return chunk('nGRP', concat([int32(id), dictionary(), int32(children.length), ...children.map(int32)]));
}

function shape(id: number, modelId: number, attributes: Record<string, string> = {}): Uint8Array {
  return chunk('nSHP', concat([int32(id), dictionary(), int32(1), int32(modelId), dictionary(attributes)]));
}

function layer(id: number, attributes: Record<string, string> = {}): Uint8Array {
  return chunk('LAYR', concat([int32(id), dictionary(attributes), int32(-1)]));
}

function coordinates(model: VoxelModel) {
  return model.voxels.map(({ x, y, z, r, g, b, colorIndex }) => ({ x, y, z, r, g, b, colorIndex }));
}

describe('decodeVox', () => {
  it('round-trips VoxelMill exports across model chunks with exact colors and orientation', () => {
    const model: VoxelModel = {
      sourceName: 'large.glb',
      voxelSize: 0.25,
      size: { x: 301, y: 302, z: 303 },
      palette: [
        { r: 12, g: 34, b: 56 },
        { r: 210, g: 80, b: 40 },
        { r: 20, g: 180, b: 220 },
      ],
      voxels: [
        { x: 0, y: 0, z: 0, r: 12, g: 34, b: 56, colorIndex: 0 },
        { x: 300, y: 301, z: 302, r: 210, g: 80, b: 40, colorIndex: 1 },
        { x: 150, y: 160, z: 170, r: 20, g: 180, b: 220, colorIndex: 2 },
      ],
    };

    const decoded = decodeVox(encodeVox(model), 'roundtrip.vox');

    expect(decoded.sourceName).toBe('roundtrip.vox');
    expect(decoded.voxelSize).toBe(1);
    expect(decoded.size).toEqual(model.size);
    expect(decoded.palette).toEqual(model.palette);
    expect(coordinates(decoded)).toEqual([
      model.voxels[0],
      model.voxels[2],
      model.voxels[1],
    ]);
  });

  it.each([
    { coordinate: { x: 300, y: 0, z: 0 }, size: { x: 301, y: 1, z: 1 } },
    { coordinate: { x: 0, y: 300, z: 0 }, size: { x: 1, y: 301, z: 1 } },
    { coordinate: { x: 0, y: 0, z: 300 }, size: { x: 1, y: 1, z: 301 } },
  ])('preserves a sparse translated VoxelMill chunk at $coordinate', ({ coordinate, size: modelSize }) => {
    const color = { r: 190, g: 90, b: 45 };
    const model: VoxelModel = {
      sourceName: 'sparse.glb',
      voxelSize: 1,
      size: modelSize,
      palette: [color],
      voxels: [{ ...coordinate, ...color, colorIndex: 0 }],
    };

    const decoded = decodeVox(encodeVox(model));

    expect(decoded.size).toEqual(modelSize);
    expect(decoded.voxels).toEqual([{ ...coordinate, ...color, colorIndex: 0 }]);
  });

  it('uses the canonical default palette when RGBA is absent', () => {
    const decoded = decodeVox(voxFile([
      size(2, 1, 1),
      xyzi([
        { x: 0, y: 0, z: 0, color: 1 },
        { x: 1, y: 0, z: 0, color: 255 },
      ]),
    ]));

    expect(decoded.palette).toHaveLength(255);
    expect(decoded.palette[0]).toEqual({ r: 255, g: 255, b: 255 });
    expect(decoded.palette[254]).toEqual({ r: 17, g: 17, b: 17 });
    expect(coordinates(decoded)).toEqual([
      { x: 0, y: 0, z: 0, r: 255, g: 255, b: 255, colorIndex: 0 },
      { x: 1, y: 0, z: 0, r: 17, g: 17, b: 17, colorIndex: 254 },
    ]);
  });

  it('accepts version 200 while preserving corner-origin coordinates in files without a scene graph', () => {
    const color = { r: 80, g: 120, b: 200 };
    const decoded = decodeVox(voxFile([
      size(4, 2, 3),
      xyzi([{ x: 3, y: 1, z: 2, color: 1 }]),
      rgba([color]),
    ], 200));

    expect(decoded.size).toEqual({ x: 4, y: 3, z: 2 });
    expect(decoded.voxels).toEqual([{ x: 3, y: 2, z: 1, colorIndex: 0, ...color }]);
  });

  it('applies IMAP to both displayed palette order and stored voxel indices', () => {
    const red = { r: 220, g: 20, b: 30 };
    const green = { r: 20, g: 210, b: 40 };
    const decoded = decodeVox(voxFile([
      size(2, 1, 1),
      xyzi([
        { x: 0, y: 0, z: 0, color: 1 },
        { x: 1, y: 0, z: 0, color: 2 },
      ]),
      rgba([red, green]),
      // IMAP is display -> stored: display colors 1 and 2 are swapped.
      imap({ 0: 2, 1: 1 }),
    ]));

    expect(decoded.palette).toEqual([green, red]);
    expect(coordinates(decoded)).toEqual([
      { x: 0, y: 0, z: 0, ...red, colorIndex: 1 },
      { x: 1, y: 0, z: 0, ...green, colorIndex: 0 },
    ]);
  });

  it('places scene-model geometry around floor(SIZE / 2), independently of VoxelMill exports', () => {
    const color = { r: 60, g: 100, b: 180 };
    const decoded = decodeVox(voxFile([
      size(4, 2, 3),
      xyzi([{ x: 3, y: 1, z: 2, color: 1 }]),
      rgba([color]),
      // A translation equal to the (2, 1, 1) center pivot places the
      // model's lower corner at world origin in a conforming reader.
      transform(0, 1, { _t: '2 1 1' }),
      shape(1, 0),
    ]));

    expect(decoded.size).toEqual({ x: 4, y: 3, z: 2 });
    expect(decoded.voxels).toEqual([{ x: 3, y: 2, z: 1, colorIndex: 0, ...color }]);
  });

  it('retains declared scene extents carried by independently-authored empty model tiles', () => {
    const decoded = decodeVox(voxFile([
      size(256, 1, 1), xyzi([]),
      size(45, 1, 1), xyzi([]),
      transform(0, 1), group(1, [2, 4]),
      transform(2, 3, { _t: '128 0 0' }), shape(3, 0),
      transform(4, 5, { _t: '278 0 0' }), shape(5, 1),
    ]));

    expect(decoded.size).toEqual({ x: 301, y: 1, z: 1 });
    expect(decoded.voxels).toEqual([]);
  });

  it('excludes instances hidden by nTRN attributes or hidden LAYR chunks', () => {
    const red = { r: 220, g: 30, b: 20 };
    const green = { r: 20, g: 210, b: 50 };
    const blue = { r: 30, g: 70, b: 220 };
    const decoded = decodeVox(voxFile([
      size(1, 1, 1), xyzi([{ x: 0, y: 0, z: 0, color: 1 }]),
      size(1, 1, 1), xyzi([{ x: 0, y: 0, z: 0, color: 2 }]),
      size(1, 1, 1), xyzi([{ x: 0, y: 0, z: 0, color: 3 }]),
      rgba([red, green, blue]),
      layer(7, { _hidden: '1' }),
      transform(0, 1), group(1, [2, 4, 6]),
      transform(2, 3), shape(3, 0),
      transform(4, 5, { _t: '5 0 0' }, { _hidden: '1' }), shape(5, 1),
      transform(6, 7, { _t: '6 0 0' }, {}, 7), shape(7, 2),
    ]));

    expect(decoded.size).toEqual({ x: 1, y: 1, z: 1 });
    expect(decoded.palette).toEqual([red]);
    expect(decoded.voxels).toEqual([{ x: 0, y: 0, z: 0, colorIndex: 0, ...red }]);
  });

  it('composes common nTRN/nGRP/nSHP translations and rotations', () => {
    const red = { r: 230, g: 30, b: 20 };
    const green = { r: 20, g: 210, b: 60 };
    // Rotation 105 is the signed row-major example from the MagicaVoxel extension spec:
    // [0 1 0; 0 0 -1; -1 0 0].
    const decoded = decodeVox(voxFile([
      size(2, 1, 1),
      xyzi([
        { x: 0, y: 0, z: 0, color: 1 },
        { x: 1, y: 0, z: 0, color: 2 },
      ]),
      rgba([red, green]),
      transform(0, 1, { _t: '10 20 30' }),
      group(1, [2]),
      transform(2, 3, { _r: '105', _t: '4 5 6' }),
      shape(3, 0),
    ]), 'scene.vox');

    expect(decoded.size).toEqual({ x: 15, y: 37, z: 25 });
    expect(decoded.palette).toEqual([red, green]);
    expect(coordinates(decoded)).toEqual([
      { x: 14, y: 35, z: 24, ...green, colorIndex: 1 },
      { x: 14, y: 36, z: 24, ...red, colorIndex: 0 },
    ]);
  });

  it('honors version-specific overlap priority for scene instance order', () => {
    const red = { r: 230, g: 20, b: 30 };
    const green = { r: 20, g: 220, b: 50 };
    const scene = [
      size(1, 1, 1), xyzi([{ x: 0, y: 0, z: 0, color: 1 }]),
      size(1, 1, 1), xyzi([{ x: 0, y: 0, z: 0, color: 2 }]),
      rgba([red, green]),
      transform(0, 1), group(1, [2, 4]),
      transform(2, 3), shape(3, 0),
      transform(4, 5), shape(5, 1),
    ];

    expect(decodeVox(voxFile(scene, 150)).voxels[0]).toMatchObject({ ...green, colorIndex: 1 });
    expect(decodeVox(voxFile(scene, 200)).voxels[0]).toMatchObject({ ...red, colorIndex: 0 });
  });

  it('normalizes negative scene coordinates while preserving relative placement', () => {
    const color = { r: 4, g: 80, b: 160 };
    const decoded = decodeVox(voxFile([
      size(2, 1, 1),
      xyzi([
        { x: 0, y: 0, z: 0, color: 1 },
        { x: 1, y: 0, z: 0, color: 1 },
      ]),
      rgba([color]),
      transform(0, 1, { _t: '-7 -3 -2' }),
      shape(1, 0),
    ]));

    expect(decoded.size).toEqual({ x: 2, y: 1, z: 1 });
    expect(decoded.voxels.map(({ x, y, z }) => ({ x, y, z }))).toEqual([
      { x: 0, y: 0, z: 0 },
      { x: 1, y: 0, z: 0 },
    ]);
  });

  it('is deterministic and honors Uint8Array byte offsets', () => {
    const source = voxFile([
      size(2, 1, 1),
      xyzi([
        { x: 1, y: 0, z: 0, color: 2 },
        { x: 0, y: 0, z: 0, color: 1 },
      ]),
      rgba([{ r: 1, g: 2, b: 3 }, { r: 4, g: 5, b: 6 }]),
    ]);
    const wrapped = new Uint8Array(source.length + 11);
    wrapped.set(source, 7);
    const view = wrapped.subarray(7, 7 + source.length);

    expect(decodeVox(view, 'offset.vox')).toEqual(decodeVox(view, 'offset.vox'));
    expect(decodeVox(view).voxels.map((voxel) => voxel.x)).toEqual([0, 1]);
  });

  it('rejects malformed headers, chunks, model pairs, and palette indices clearly', () => {
    const badSignature = voxFile([size(1, 1, 1), xyzi([])]);
    badSignature[0] = 0;
    expect(() => decodeVox(badSignature)).toThrow(/signature/u);

    const badVersion = voxFile([size(1, 1, 1), xyzi([])]);
    new DataView(badVersion.buffer).setUint32(4, 149, true);
    expect(() => decodeVox(badVersion)).toThrow(/Unsupported VOX version 149/u);

    const truncated = voxFile([size(1, 1, 1), xyzi([])]).slice(0, -1);
    expect(() => decodeVox(truncated)).toThrow(/exceeds|truncated/u);

    expect(() => decodeVox(voxFile([size(1, 1, 1)]))).toThrow(/missing its XYZI pair/u);
    expect(() => decodeVox(voxFile([size(1, 1, 1), xyzi([{ x: 0, y: 0, z: 0, color: 0 }])]))).toThrow(/reserved palette index 0/u);
    expect(() => decodeVox(voxFile([size(1, 1, 1), xyzi([{ x: 1, y: 0, z: 0, color: 1 }])]))).toThrow(/outside its SIZE/u);

    const mismatchedPack = chunk('PACK', int32(2));
    expect(() => decodeVox(voxFile([mismatchedPack, size(1, 1, 1), xyzi([])]))).toThrow(/PACK declares 2 models/u);

    const duplicateMap = new Uint8Array(256);
    expect(() => decodeVox(voxFile([
      size(1, 1, 1), xyzi([]), chunk('IMAP', duplicateMap),
    ]))).toThrow(/IMAP must be a permutation/u);

    expect(() => decodeVox(voxFile([
      size(1, 1, 1), xyzi([]), chunk('IMAP', new Uint8Array(255)),
    ]))).toThrow(/IMAP must contain exactly 256/u);
  });

  it('rejects broken scene references and transformed scenes beyond the shared coordinate limit', () => {
    const base = [size(1, 1, 1), xyzi([{ x: 0, y: 0, z: 0, color: 1 }])];

    expect(() => decodeVox(voxFile([...base, transform(0, 99)]))).toThrow(/node 99 is referenced but missing/u);
    expect(() => decodeVox(voxFile([
      ...base,
      transform(0, 1, { _t: '1024 0 0' }),
      shape(1, 0),
    ]))).toThrow(/does not fit the 1024/u);
  });

  it('uses a dedicated error type for callers that need structured import handling', () => {
    expect(() => decodeVox(new Uint8Array())).toThrow(VoxImportError);
  });
});
