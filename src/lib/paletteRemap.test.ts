import { describe, expect, it } from 'vitest';
import type { RGB, VoxelModel } from '../types';
import { rgbToHex } from './aiPaletteContract';
import { applyPaletteRemapPlan, planVoxelPaletteRemap, remapVoxelPalette } from './paletteRemap';
import { packVoxelCoordinate } from './voxelIndex';

const colors: RGB[] = [
  { r: 15, g: 15, b: 18 },
  { r: 100, g: 105, b: 112 },
  { r: 235, g: 238, b: 242 },
];

const model: VoxelModel = {
  sourceName: 'tones.glb', voxelSize: 1, size: { x: 6, y: 1, z: 1 }, palette: colors,
  voxels: colors.flatMap((color, colorIndex) => [0, 1].map((offset) => ({
    x: colorIndex * 2 + offset, y: 0, z: 0, ...color, colorIndex,
  }))),
};

const assertPaletteInvariant = (candidate: VoxelModel) => {
  expect(candidate.palette.length).toBeLessThanOrEqual(255);
  for (const voxel of candidate.voxels) {
    expect({ r: voxel.r, g: voxel.g, b: voxel.b }).toEqual(candidate.palette[voxel.colorIndex]);
  }
};

describe('deterministic palette remapping', () => {
  it('preserves shadow-to-highlight order during a bold hue change', () => {
    const target = ['#07152c', '#24538a', '#c7ebff'];
    const preview = remapVoxelPalette(model, target, { scope: 'model', mode: 'tonal' });
    const mapped = preview.mapping.map((entry) => rgbToHex(entry.after));
    expect(mapped).toEqual(target);
    expect(preview.metrics.changedVoxels).toBe(6);
    expect(preview.metrics.targetColorsUsed).toBe(3);
    assertPaletteInvariant(preview.model);
  });

  it('maps every voxel sharing a source palette index to one coherent color', () => {
    const preview = remapVoxelPalette(model, ['#210021', '#b44876'], { scope: 'model' });
    for (const index of [0, 1, 2]) {
      const outputs = new Set(preview.model.voxels.filter((voxel) => model.voxels[voxel.x].colorIndex === index).map((voxel) => rgbToHex(voxel)));
      expect(outputs.size).toBe(1);
    }
  });

  it('keeps the darkest and lightest endpoints when the target ramp is larger', () => {
    const endpointModel: VoxelModel = {
      sourceName: 'endpoints.glb', voxelSize: 1, size: { x: 2, y: 1, z: 1 },
      palette: [{ r: 0, g: 0, b: 0 }, { r: 255, g: 255, b: 255 }],
      voxels: [
        { x: 0, y: 0, z: 0, r: 0, g: 0, b: 0, colorIndex: 0 },
        { x: 1, y: 0, z: 0, r: 255, g: 255, b: 255, colorIndex: 1 },
      ],
    };
    const target = ['#081018', '#35475a', '#91a8bd', '#f4fbff'];
    const preview = remapVoxelPalette(endpointModel, target, { scope: 'model', mode: 'tonal' });
    expect(preview.mapping.map((entry) => rgbToHex(entry.after))).toEqual([target[0], target[3]]);
  });

  it('uses palette ranks rather than voxel frequency for a skewed tonal ramp', () => {
    const skewed: VoxelModel = {
      sourceName: 'skewed.glb', voxelSize: 1, size: { x: 102, y: 1, z: 1 }, palette: colors,
      voxels: [
        ...Array.from({ length: 100 }, (_, x) => ({ x, y: 0, z: 0, ...colors[0], colorIndex: 0 })),
        { x: 100, y: 0, z: 0, ...colors[1], colorIndex: 1 },
        { x: 101, y: 0, z: 0, ...colors[2], colorIndex: 2 },
      ],
    };
    const target = ['#040810', '#405979', '#dcecff'];
    const preview = remapVoxelPalette(skewed, target, { scope: 'model', mode: 'tonal' });
    expect(preview.mapping.map((entry) => rgbToHex(entry.after))).toEqual(target);
  });

  it('preserves locked colors exactly', () => {
    const locked = new Set([rgbToHex(colors[1])]);
    const preview = remapVoxelPalette(model, ['#001122', '#44aa66', '#eeffcc'], { scope: 'model', lockedColors: locked });
    const middle = preview.model.voxels.filter((voxel) => voxel.x === 2 || voxel.x === 3);
    expect(middle.every((voxel) => rgbToHex(voxel) === '#646970')).toBe(true);
    expect(preview.metrics.lockedVoxels).toBe(2);
    assertPaletteInvariant(preview.model);
  });

  it('keeps a locked midpoint out of the unlocked shadow and highlight mapping', () => {
    const locked = new Set([rgbToHex(colors[1])]);
    const preview = remapVoxelPalette(model, ['#06101d', '#646970', '#e5f4ff'], {
      scope: 'model', lockedColors: locked, mode: 'tonal',
    });
    expect(preview.mapping.map((entry) => rgbToHex(entry.after))).toEqual(['#06101d', '#646970', '#e5f4ff']);
  });

  it('retains unused locked swatches in whole-model and selection remaps', () => {
    const unused = { r: 255, g: 0, b: 255 };
    const withUnused: VoxelModel = { ...model, palette: [...model.palette, unused] };
    const locked = new Set([rgbToHex(unused)]);
    const whole = remapVoxelPalette(withUnused, ['#102030', '#607080', '#e0f0ff'], {
      scope: 'model', lockedColors: locked,
    });
    const selection = new Set([packVoxelCoordinate(withUnused.voxels[0])]);
    const partial = remapVoxelPalette(withUnused, ['#102030', '#607080'], {
      scope: 'selection', selection, lockedColors: locked,
    });
    expect(whole.model.palette.map(rgbToHex)).toContain('#ff00ff');
    expect(partial.model.palette[3]).toEqual(unused);
  });

  it('changes only selected voxels and leaves unselected objects byte-for-byte intact', () => {
    const selection = new Set([packVoxelCoordinate(model.voxels[0]), packVoxelCoordinate(model.voxels[2])]);
    const preview = remapVoxelPalette(model, ['#003300', '#77dd77'], { scope: 'selection', selection });
    expect(preview.metrics.affectedVoxels).toBe(2);
    for (let index = 0; index < model.voxels.length; index += 1) {
      if (!selection.has(packVoxelCoordinate(model.voxels[index]))) expect(preview.model.voxels[index]).toBe(model.voxels[index]);
    }
    assertPaletteInvariant(preview.model);
  });

  it('is deterministic and does not mutate its inputs', () => {
    const snapshot = structuredClone(model);
    const first = remapVoxelPalette(model, ['#160b2c', '#784ea0', '#f9d7ff'], { scope: 'model' });
    const second = remapVoxelPalette(model, ['#160b2c', '#784ea0', '#f9d7ff'], { scope: 'model' });
    expect(first).toEqual(second);
    expect(model).toEqual(snapshot);
  });

  it('materializes a lightweight remap plan to the same committed model', () => {
    const target = ['#160b2c', '#784ea0', '#f9d7ff'];
    const plan = planVoxelPaletteRemap(model, target, { scope: 'model' });
    expect(applyPaletteRemapPlan(model, plan)).toEqual(remapVoxelPalette(model, target, { scope: 'model' }).model);
  });

  it('returns a safe no-op for a stale or empty selection', () => {
    const preview = remapVoxelPalette(model, ['#123456', '#abcdef'], { scope: 'selection', selection: new Set([999_999]) });
    expect(preview.model).toBe(model);
    expect(preview.warnings).toContain('The selection no longer contains any voxels.');
  });

  it('falls back safely when all 255 selection palette slots are protected', () => {
    const palette = Array.from({ length: 255 }, (_, index) => ({ r: index, g: index, b: index }));
    const full: VoxelModel = {
      sourceName: 'full.glb', voxelSize: 1, size: { x: 256, y: 1, z: 1 }, palette,
      voxels: [
        ...palette.map((color, colorIndex) => ({ x: colorIndex, y: 0, z: 0, ...color, colorIndex })),
        { x: 255, y: 0, z: 0, ...palette[0], colorIndex: 0 },
      ],
    };
    const selection = new Set([packVoxelCoordinate(full.voxels[255])]);
    const preview = remapVoxelPalette(full, ['#ff00ff', '#00ffff'], { scope: 'selection', selection });
    expect(preview.model.palette).toHaveLength(255);
    expect(preview.metrics.capacityFallbacks).toBeGreaterThan(0);
    expect(preview.model.voxels.slice(0, 255)).toEqual(full.voxels.slice(0, 255));
    assertPaletteInvariant(preview.model);
  });
});
