import { describe, expect, it } from 'vitest';
import type { VoxelModel } from '../types';
import { encodeVox } from './voxExport';

describe('encodeVox', () => {
  it('writes a MagicaVoxel 150 file with SIZE, XYZI and RGBA chunks', () => {
    const model: VoxelModel = {
      sourceName: 'test.glb',
      voxelSize: 1,
      size: { x: 2, y: 3, z: 4 },
      palette: [{ r: 12, g: 34, b: 56 }],
      voxels: [{ x: 1, y: 2, z: 3, r: 12, g: 34, b: 56, colorIndex: 0 }],
    };
    const bytes = encodeVox(model);
    const text = new TextDecoder().decode(bytes);
    const view = new DataView(bytes.buffer);

    expect(text.slice(0, 4)).toBe('VOX ');
    expect(view.getUint32(4, true)).toBe(150);
    expect(text).toContain('MAIN');
    expect(text).toContain('SIZE');
    expect(text).toContain('XYZI');
    expect(text).toContain('RGBA');
    expect(bytes.at(60)).toBe(1); // X
    expect(bytes.at(61)).toBe(3); // source Z -> VOX Y
    expect(bytes.at(62)).toBe(2); // source Y -> VOX Z
    expect(bytes.at(63)).toBe(1); // palette index, one-based
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
    const text = new TextDecoder().decode(encodeVox(model));
    expect(text).toContain('PACK');
    expect(text.match(/SIZE/g)).toHaveLength(2);
    expect(text).toContain('nTRN');
    expect(text).toContain('_t');
    expect(text).toContain('256 0 0');
  });
});
