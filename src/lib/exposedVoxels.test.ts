import { describe, expect, it } from 'vitest';
import type { Voxel } from '../types';
import { getExposedVoxels } from './exposedVoxels';
import { MAX_VOXEL_COORDINATE } from './voxelIndex';

const voxel = (x: number, y: number, z: number, colorIndex = 0): Voxel => ({
  x,
  y,
  z,
  colorIndex,
  r: colorIndex ? 220 : 20,
  g: colorIndex ? 40 : 30,
  b: colorIndex ? 30 : 40,
});

const block = (origin: { x: number; y: number; z: number }, size: number): Voxel[] => {
  const voxels: Voxel[] = [];
  for (let z = 0; z < size; z += 1) {
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        voxels.push(voxel(origin.x + x, origin.y + y, origin.z + z));
      }
    }
  }
  return voxels;
};

describe('getExposedVoxels', () => {
  it('removes only the fully enclosed center of a solid 3x3x3 block', () => {
    const voxels = block({ x: 10, y: 20, z: 30 }, 3);
    const exposed = getExposedVoxels(voxels);

    expect(exposed).toHaveLength(26);
    expect(exposed).not.toContain(voxels.find(({ x, y, z }) => x === 11 && y === 21 && z === 31));
  });

  it('keeps every voxel in a hollow shell, including faces exposed to its cavity', () => {
    const shell = block({ x: 10, y: 20, z: 30 }, 3)
      .filter(({ x, y, z }) => x !== 11 || y !== 21 || z !== 31);

    expect(getExposedVoxels(shell)).toEqual(shell);
  });

  it('keeps sparse and disconnected voxels', () => {
    const voxels = [
      voxel(4, 8, 12),
      voxel(5, 8, 12),
      voxel(400, 500, 600, 1),
      voxel(900, 200, 700),
    ];

    expect(getExposedVoxels(voxels)).toEqual(voxels);
  });

  it('treats both minimum and maximum grid boundaries as exposed', () => {
    const minimum = voxel(0, 10, 10);
    const maximum = voxel(MAX_VOXEL_COORDINATE, 20, 20);
    const voxels = [
      minimum,
      voxel(1, 10, 10),
      voxel(0, 9, 10),
      voxel(0, 11, 10),
      voxel(0, 10, 9),
      voxel(0, 10, 11),
      maximum,
      voxel(MAX_VOXEL_COORDINATE - 1, 20, 20),
      voxel(MAX_VOXEL_COORDINATE, 19, 20),
      voxel(MAX_VOXEL_COORDINATE, 21, 20),
      voxel(MAX_VOXEL_COORDINATE, 20, 19),
      voxel(MAX_VOXEL_COORDINATE, 20, 21),
    ];

    const exposed = getExposedVoxels(voxels);
    expect(exposed).toContain(minimum);
    expect(exposed).toContain(maximum);
  });

  it('preserves input ordering and voxel object identity', () => {
    const solid = block({ x: 10, y: 10, z: 10 }, 3);
    const input = [...solid].reverse();
    const enclosed = solid.find(({ x, y, z }) => x === 11 && y === 11 && z === 11);
    const expected = input.filter((entry) => entry !== enclosed);

    const exposed = getExposedVoxels(input);
    expect(exposed).toEqual(expected);
    exposed.forEach((entry, index) => expect(entry).toBe(expected[index]));
  });

  it('does not mutate the input array or voxel records', () => {
    const voxels = block({ x: 10, y: 10, z: 10 }, 3);
    const before = voxels.map((entry) => ({ ...entry }));

    getExposedVoxels(voxels);

    expect(voxels).toEqual(before);
    voxels.forEach((entry, index) => expect(entry).toEqual(before[index]));
  });
});
