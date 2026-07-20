import { describe, expect, it } from 'vitest';
import type { RGB, VoxelModel } from '../types';
import { rgbToHex } from './aiPaletteContract';
import { applyPaletteRemapPlan, planVoxelPaletteRemap, preparePaletteCandidate, remapVoxelPalette } from './paletteRemap';
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

const hex = (value: string): RGB => ({
  r: Number.parseInt(value.slice(1, 3), 16),
  g: Number.parseInt(value.slice(3, 5), 16),
  b: Number.parseInt(value.slice(5, 7), 16),
});

const weaponRampModel = () => {
  const ramps = [
    ['#0c0f11', '#394147', '#78838a', '#d2d9dc'],
    ['#2a0908', '#7d2019', '#d85336'],
    ['#06252b', '#07859a', '#71efff'],
  ];
  const counts = [80, 18, 4];
  const palette = ramps.flat().map(hex);
  const voxels: VoxelModel['voxels'] = [];
  let x = 0;
  let colorIndex = 0;
  for (let ramp = 0; ramp < ramps.length; ramp += 1) {
    for (const color of ramps[ramp]) {
      for (let count = 0; count < counts[ramp]; count += 1) {
        voxels.push({ x, y: 0, z: 0, ...hex(color), colorIndex });
        x += 1;
      }
      colorIndex += 1;
    }
  }
  return {
    model: { sourceName: 'weapon.glb', voxelSize: 1, size: { x, y: 1, z: 1 }, palette, voxels } satisfies VoxelModel,
    ramps,
  };
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

  it('treats palette-index-only remaps as visual no-ops for whole models and selections', () => {
    const red = { r: 255, g: 0, b: 0 };
    const duplicatePaletteModel: VoxelModel = {
      sourceName: 'duplicate-reds.glb', voxelSize: 1, size: { x: 2, y: 1, z: 1 }, palette: [red, { ...red }],
      voxels: [
        { x: 0, y: 0, z: 0, ...red, colorIndex: 0 },
        { x: 1, y: 0, z: 0, ...red, colorIndex: 1 },
      ],
    };
    const whole = planVoxelPaletteRemap(duplicatePaletteModel, ['#ff0000'], { scope: 'model', contrast: 'exact' });
    const selection = new Set([packVoxelCoordinate(duplicatePaletteModel.voxels[1])]);
    const partial = planVoxelPaletteRemap(duplicatePaletteModel, ['#ff0000'], { scope: 'selection', selection, contrast: 'exact' });

    expect(whole.colorIndexBySource.get(1)).toBe(0);
    expect(whole.metrics.changedVoxels).toBe(0);
    expect(partial.colorIndexBySource.get(1)).toBe(0);
    expect(partial.metrics.changedVoxels).toBe(0);
    expect(applyPaletteRemapPlan(duplicatePaletteModel, whole)).toBe(duplicatePaletteModel);
    expect(applyPaletteRemapPlan(duplicatePaletteModel, partial)).toBe(duplicatePaletteModel);
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

  it('keeps weapon body, trim, and energy ramps in separate coherent target families', () => {
    const { model: weapon, ramps } = weaponRampModel();
    const targetFamilies = [
      ['#0a1c0d', '#285a31', '#69a45f', '#c7e8ac'],
      ['#2b1203', '#81430b', '#e3a33e'],
      ['#17082e', '#682aaf', '#dda5ff'],
    ];
    const shuffledTarget = [
      targetFamilies[2][1], targetFamilies[0][0], targetFamilies[1][2], targetFamilies[0][2], targetFamilies[2][0],
      targetFamilies[1][0], targetFamilies[0][3], targetFamilies[2][2], targetFamilies[1][1], targetFamilies[0][1],
    ];
    const preview = remapVoxelPalette(weapon, shuffledTarget, { scope: 'model', mode: 'tonal' });
    const mapped = preview.mapping.map((entry) => rgbToHex(entry.after));
    let offset = 0;
    for (let familyIndex = 0; familyIndex < ramps.length; familyIndex += 1) {
      const familyOutput = mapped.slice(offset, offset + ramps[familyIndex].length);
      expect(familyOutput.every((color) => targetFamilies[familyIndex].includes(color))).toBe(true);
      offset += ramps[familyIndex].length;
    }
    expect(preview.metrics.sourceFamilies).toBe(3);
    expect(preview.metrics.targetFamilies).toBe(3);
    expect(preview.metrics.familyMerges).toBe(0);
    expect(preview.metrics.toneOrderRetention).toBe(100);
    assertPaletteInvariant(preview.model);
  });

  it('is invariant to AI swatch order instead of assigning hues by array position', () => {
    const { model: weapon } = weaponRampModel();
    const target = ['#0a1c0d', '#285a31', '#69a45f', '#c7e8ac', '#2b1203', '#81430b', '#e3a33e', '#17082e', '#682aaf', '#dda5ff'];
    const shuffled = [target[7], target[2], target[5], target[0], target[9], target[3], target[6], target[1], target[8], target[4]];
    const ordered = remapVoxelPalette(weapon, target, { scope: 'model' });
    const permuted = remapVoxelPalette(weapon, shuffled, { scope: 'model' });
    expect(permuted.mapping).toEqual(ordered.mapping);
    expect(permuted.model).toEqual(ordered.model);
  });

  it('excludes unrelated generated hue ramps instead of scattering them through one material', () => {
    const target = ['#080808', '#686868', '#ededed', '#2c0508', '#c52f39', '#06172f', '#287dcc'];
    const preview = remapVoxelPalette(model, target, { scope: 'model' });
    expect(preview.mapping.map((entry) => rgbToHex(entry.after)))
      .toEqual(['#080808', '#686868', '#ededed']);
    expect(preview.metrics.targetFamilies).toBe(3);
    expect(preview.warnings.join(' ')).toMatch(/unrelated candidate color ramps were excluded/u);
    expect(preview.warnings.join(' ')).not.toMatch(/\bAI\b|prompt/iu);
  });

  it('removes near-duplicate swatches and expands flat candidates with the readable guard', () => {
    const flat = ['#514e50', '#524f51', '#655f62', '#756e72', '#827a7e'];
    const preview = remapVoxelPalette(model, flat, { scope: 'model', contrast: 'readable' });
    expect(preview.metrics.contrastAdjusted).toBe(true);
    expect(preview.metrics.nearDuplicateColorsRemoved).toBeGreaterThan(0);
    expect(preview.metrics.targetColorsAccepted).toBeLessThan(flat.length);
    expect(preview.metrics.lightnessSpan).toBeGreaterThan(0.25);
    expect(preview.plan.preparedPalette.map(rgbToHex)).not.toEqual(flat);
    expect(preparePaletteCandidate(flat).map(rgbToHex)).toEqual(preview.plan.preparedPalette.map(rgbToHex));
    expect(preview.plan.appliedPalette).toHaveLength(preview.metrics.targetColorsUsed);
    expect(preview.warnings.join(' ')).toMatch(/near-duplicate|lightness range/u);
    expect(preview.warnings.join(' ')).not.toMatch(/\bAI\b|prompt/iu);
  });

  it('lets artists opt out of automatic palette quality constraints', () => {
    const flat = ['#514e50', '#524f51', '#655f62', '#756e72'];
    const preview = remapVoxelPalette(model, flat, { scope: 'model', contrast: 'exact' });
    expect(preview.metrics.contrastAdjusted).toBe(false);
    expect(preview.metrics.nearDuplicateColorsRemoved).toBe(0);
    expect(preview.metrics.targetColorsAccepted).toBe(flat.length);
    expect(preview.plan.preparedPalette.map(rgbToHex)).toEqual(flat);
    expect(preparePaletteCandidate(flat, new Set(), 'exact').map(rgbToHex)).toEqual(flat);
  });

  it('uses whole-model material context when remapping a one-shade selection', () => {
    const { model: weapon } = weaponRampModel();
    const selectedVoxel = weapon.voxels.find((voxel) => voxel.colorIndex === 5)!;
    const selection = new Set([packVoxelCoordinate(selectedVoxel)]);
    const target = ['#0a1c0d', '#285a31', '#69a45f', '#c7e8ac', '#2b1203', '#81430b', '#e3a33e', '#17082e', '#682aaf', '#dda5ff'];
    const whole = remapVoxelPalette(weapon, target, { scope: 'model' });
    const partial = remapVoxelPalette(weapon, target, { scope: 'selection', selection });
    expect(rgbToHex(partial.mapping[0].after)).toBe(rgbToHex(whole.mapping.find((entry) => entry.sourceIndex === 5)!.after));
    expect(partial.model.voxels.filter((voxel) => !selection.has(packVoxelCoordinate(voxel))))
      .toEqual(weapon.voxels.filter((voxel) => !selection.has(packVoxelCoordinate(voxel))));
  });
});
