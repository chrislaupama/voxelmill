import { describe, expect, it } from 'vitest';
import type { VoxelModel } from '../types';
import { encodeQb } from './qbExport';

describe('encodeQb', () => {
  it('writes a compressed RGBA Qubicle Binary matrix without palette loss', () => {
    const model: VoxelModel = {
      sourceName: 'color.glb', voxelSize: 1, size: { x: 2, y: 1, z: 1 },
      palette: [{ r: 12, g: 34, b: 56 }, { r: 200, g: 100, b: 50 }],
      voxels: [
        { x: 0, y: 0, z: 0, r: 12, g: 34, b: 56, colorIndex: 0 },
        { x: 1, y: 0, z: 0, r: 200, g: 100, b: 50, colorIndex: 1 },
      ],
    };
    const bytes = encodeQb(model);
    const view = new DataView(bytes.buffer);
    expect(view.getUint32(0, true)).toBe(0x00000101);
    expect(view.getUint32(4, true)).toBe(0);
    expect(view.getUint32(12, true)).toBe(1);
    expect(view.getUint32(20, true)).toBe(1);
    expect([...bytes]).toEqual(expect.arrayContaining([12, 34, 56, 255, 200, 100, 50, 255]));
  });
});
