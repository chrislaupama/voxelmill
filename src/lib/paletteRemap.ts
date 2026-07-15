import type { RGB, VoxelModel } from '../types';
import { nearestPaletteIndex, perceptualColorDistance, rgbToOklch } from './palette';
import { hexToRgb, rgbToHex } from './aiPaletteContract';
import { packVoxelCoordinate } from './voxelIndex';

export type PaletteRemapMode = 'tonal' | 'appearance';
export type PaletteRemapScope = 'model' | 'selection';

export interface PaletteRemapOptions {
  scope: PaletteRemapScope;
  selection?: ReadonlySet<number>;
  lockedColors?: ReadonlySet<string>;
  mode?: PaletteRemapMode;
}

export interface PaletteMapping {
  sourceIndex: number;
  before: RGB;
  after: RGB;
  voxelCount: number;
  locked: boolean;
}

export interface PaletteRemapMetrics {
  affectedVoxels: number;
  changedVoxels: number;
  lockedVoxels: number;
  sourceColors: number;
  targetColorsUsed: number;
  paletteSizeBefore: number;
  paletteSizeAfter: number;
  meanColorMovement: number;
  capacityFallbacks: number;
}

export interface PaletteRemapPreview {
  model: VoxelModel;
  plan: PaletteRemapPlan;
  mapping: PaletteMapping[];
  metrics: PaletteRemapMetrics;
  warnings: string[];
}

export interface PaletteRemapPlan {
  scope: PaletteRemapScope;
  selection?: ReadonlySet<number>;
  palette: RGB[];
  colorIndexBySource: ReadonlyMap<number, number>;
  mapping: PaletteMapping[];
  metrics: PaletteRemapMetrics;
  warnings: string[];
}

interface SourceEntry {
  index: number;
  color: RGB;
  count: number;
  locked: boolean;
}

const sameColor = (left: RGB, right: RGB) => left.r === right.r && left.g === right.g && left.b === right.b;

function uniqueColors(colors: RGB[]) {
  const seen = new Set<string>();
  return colors.filter((color) => {
    const hex = rgbToHex(color);
    if (seen.has(hex)) return false;
    seen.add(hex);
    return true;
  });
}

function tonalMapping(sources: SourceEntry[], targets: RGB[]): Map<number, RGB> {
  const mapping = new Map<number, RGB>();
  if (!sources.length || !targets.length) return mapping;
  const sourceFeatures = sources.map((entry) => ({ entry, feature: rgbToOklch(entry.color) }));
  const targetFeatures = targets.map((color, index) => ({ color, index, feature: rgbToOklch(color) }));
  const neutralThreshold = 0.045;
  const sourceHasNeutral = sourceFeatures.some(({ feature }) => feature.c < neutralThreshold);
  const sourceHasChromatic = sourceFeatures.some(({ feature }) => feature.c >= neutralThreshold);
  const targetHasNeutral = targetFeatures.some(({ feature }) => feature.c < neutralThreshold);
  const targetHasChromatic = targetFeatures.some(({ feature }) => feature.c >= neutralThreshold);
  const splitGroups = sourceHasNeutral && sourceHasChromatic && targetHasNeutral && targetHasChromatic;
  const groups = splitGroups ? ['neutral', 'chromatic'] as const : ['all'] as const;

  for (const group of groups) {
    const sourceGroup = sourceFeatures.filter(({ feature }) => group === 'all' || (feature.c < neutralThreshold ? 'neutral' : 'chromatic') === group)
      .sort((left, right) => left.feature.l - right.feature.l || left.feature.c - right.feature.c
        || left.feature.h - right.feature.h || left.entry.index - right.entry.index);
    const targetGroup = targetFeatures.filter(({ feature }) => group === 'all' || (feature.c < neutralThreshold ? 'neutral' : 'chromatic') === group)
      .sort((left, right) => left.feature.l - right.feature.l || left.feature.c - right.feature.c
        || left.feature.h - right.feature.h || left.index - right.index);
    if (!targetGroup.length) continue;
    for (let sourceIndex = 0; sourceIndex < sourceGroup.length; sourceIndex += 1) {
      const { entry, feature } = sourceGroup[sourceIndex];
      const targetIndex = sourceGroup.length === 1
        ? targetGroup.reduce((best, candidate, index) => (
          Math.abs(candidate.feature.l - feature.l) < Math.abs(targetGroup[best].feature.l - feature.l) ? index : best
        ), 0)
        : Math.round(sourceIndex / (sourceGroup.length - 1) * (targetGroup.length - 1));
      mapping.set(entry.index, targetGroup[targetIndex].color);
    }
  }
  return mapping;
}

function mapSources(sources: SourceEntry[], targets: RGB[], mode: PaletteRemapMode) {
  const unlocked = sources.filter((entry) => !entry.locked);
  const mapping = mode === 'appearance'
    ? new Map(unlocked.map((entry) => [entry.index, targets[nearestPaletteIndex(entry.color, targets)]]))
    : tonalMapping(unlocked, targets);
  for (const entry of sources) if (entry.locked) mapping.set(entry.index, entry.color);
  return mapping;
}

function sourceEntries(model: VoxelModel, selection: ReadonlySet<number> | undefined, locked: ReadonlySet<string>) {
  const counts = new Map<number, number>();
  for (const voxel of model.voxels) {
    if (selection && !selection.has(packVoxelCoordinate(voxel))) continue;
    counts.set(voxel.colorIndex, (counts.get(voxel.colorIndex) ?? 0) + 1);
  }
  return [...counts.entries()].sort(([left], [right]) => left - right).map(([index, count]) => ({
    index,
    count,
    color: model.palette[index],
    locked: locked.has(rgbToHex(model.palette[index])),
  }));
}

function mappingSummary(sources: SourceEntry[], mappedColors: Map<number, RGB>): PaletteMapping[] {
  return sources.map((entry) => ({
    sourceIndex: entry.index,
    before: entry.color,
    after: mappedColors.get(entry.index) ?? entry.color,
    voxelCount: entry.count,
    locked: entry.locked,
  }));
}

function movement(mapping: PaletteMapping[]) {
  const total = mapping.reduce((sum, entry) => sum + entry.voxelCount, 0);
  if (!total) return 0;
  return mapping.reduce((sum, entry) => sum + perceptualColorDistance(entry.before, entry.after) * entry.voxelCount, 0) / total;
}

function planWholeModel(
  model: VoxelModel,
  targets: RGB[],
  sources: SourceEntry[],
  locked: ReadonlySet<string>,
  mode: PaletteRemapMode,
): PaletteRemapPlan {
  const lockedColors = model.palette.filter((color) => locked.has(rgbToHex(color)));
  const palette = uniqueColors([...lockedColors, ...targets]).slice(0, 255);
  const unlockedTargets = palette.filter((color) => !locked.has(rgbToHex(color)));
  const mappedColors = mapSources(sources, unlockedTargets.length ? unlockedTargets : palette, mode);
  const paletteIndices = new Map(palette.map((color, index) => [rgbToHex(color), index]));
  const colorIndexBySource = new Map<number, number>();
  for (const source of sources) {
    const colorIndex = paletteIndices.get(rgbToHex(mappedColors.get(source.index) ?? source.color));
    if (colorIndex !== undefined) colorIndexBySource.set(source.index, colorIndex);
  }
  const mapping = mappingSummary(sources, mappedColors);
  const changedVoxels = sources.reduce((count, source) => {
    const colorIndex = colorIndexBySource.get(source.index);
    const color = colorIndex === undefined ? source.color : palette[colorIndex];
    return count + (source.index === colorIndex && sameColor(source.color, color) ? 0 : source.count);
  }, 0);
  return {
    scope: 'model',
    palette,
    colorIndexBySource,
    mapping,
    metrics: {
      affectedVoxels: model.voxels.length,
      changedVoxels,
      lockedVoxels: sources.filter((entry) => entry.locked).reduce((sum, entry) => sum + entry.count, 0),
      sourceColors: sources.length,
      targetColorsUsed: new Set(mapping.map((entry) => rgbToHex(entry.after))).size,
      paletteSizeBefore: model.palette.length,
      paletteSizeAfter: changedVoxels ? palette.length : model.palette.length,
      meanColorMovement: movement(mapping),
      capacityFallbacks: 0,
    },
    warnings: [],
  };
}

function planSelection(
  model: VoxelModel,
  targets: RGB[],
  sources: SourceEntry[],
  selection: ReadonlySet<number>,
  locked: ReadonlySet<string>,
  mode: PaletteRemapMode,
): PaletteRemapPlan {
  const unlockedTargets = targets.filter((color) => !locked.has(rgbToHex(color)));
  const requestedColors = mapSources(sources, unlockedTargets.length ? unlockedTargets : targets, mode);
  const protectedIndices = new Set<number>();
  model.palette.forEach((color, index) => {
    if (locked.has(rgbToHex(color))) protectedIndices.add(index);
  });
  for (const voxel of model.voxels) {
    const selected = selection.has(packVoxelCoordinate(voxel));
    if (!selected || locked.has(rgbToHex(model.palette[voxel.colorIndex]))) protectedIndices.add(voxel.colorIndex);
  }
  const palette = model.palette.map((color) => ({ ...color }));
  const claimedIndices = new Set<number>();
  const availableIndices = model.palette.map((_, index) => index).filter((index) => !protectedIndices.has(index));
  const resolvedByHex = new Map<string, number>();
  let capacityFallbacks = 0;

  const resolveColor = (color: RGB) => {
    const hex = rgbToHex(color);
    const resolved = resolvedByHex.get(hex);
    if (resolved !== undefined) return resolved;
    const exact = palette.findIndex((candidate, index) => !claimedIndices.has(index) && sameColor(candidate, color));
    if (exact >= 0) {
      claimedIndices.add(exact);
      resolvedByHex.set(hex, exact);
      return exact;
    }
    const reusablePosition = availableIndices.findIndex((index) => !claimedIndices.has(index));
    if (reusablePosition >= 0) {
      const index = availableIndices[reusablePosition];
      palette[index] = color;
      claimedIndices.add(index);
      resolvedByHex.set(hex, index);
      return index;
    }
    if (palette.length < 255) {
      const index = palette.length;
      palette.push(color);
      claimedIndices.add(index);
      resolvedByHex.set(hex, index);
      return index;
    }
    capacityFallbacks += 1;
    const index = nearestPaletteIndex(color, palette);
    resolvedByHex.set(hex, index);
    return index;
  };

  const targetIndices = new Map<number, number>();
  for (const source of sources) {
    const requested = requestedColors.get(source.index) ?? source.color;
    targetIndices.set(source.index, source.locked ? source.index : resolveColor(requested));
  }
  const actualColors = new Map<number, RGB>();
  for (const source of sources) actualColors.set(source.index, palette[targetIndices.get(source.index) ?? source.index]);
  const mapping = mappingSummary(sources, actualColors);
  const changedVoxels = sources.reduce((count, source) => {
    const colorIndex = targetIndices.get(source.index);
    const color = colorIndex === undefined ? source.color : palette[colorIndex];
    return count + (source.index === colorIndex && sameColor(source.color, color) ? 0 : source.count);
  }, 0);
  const warnings = capacityFallbacks
    ? [`${capacityFallbacks} requested color${capacityFallbacks === 1 ? '' : 's'} used the closest protected swatch because the 255-color palette is full.`]
    : [];
  return {
    scope: 'selection',
    selection,
    palette,
    colorIndexBySource: targetIndices,
    mapping,
    metrics: {
      affectedVoxels: sources.reduce((sum, entry) => sum + entry.count, 0),
      changedVoxels,
      lockedVoxels: sources.filter((entry) => entry.locked).reduce((sum, entry) => sum + entry.count, 0),
      sourceColors: sources.length,
      targetColorsUsed: new Set(mapping.map((entry) => rgbToHex(entry.after))).size,
      paletteSizeBefore: model.palette.length,
      paletteSizeAfter: changedVoxels ? palette.length : model.palette.length,
      meanColorMovement: movement(mapping),
      capacityFallbacks,
    },
    warnings,
  };
}

export function planVoxelPaletteRemap(model: VoxelModel, targetHexColors: string[], options: PaletteRemapOptions): PaletteRemapPlan {
  const targets = uniqueColors(targetHexColors.map((color) => hexToRgb(color)));
  if (targets.length < 1) throw new Error('A palette candidate must contain at least one color.');
  const locked = options.lockedColors ?? new Set<string>();
  const selection = options.scope === 'selection' ? options.selection ?? new Set<number>() : undefined;
  const sources = sourceEntries(model, selection, locked);
  if (!sources.length) {
    return {
      scope: options.scope,
      selection,
      palette: model.palette,
      colorIndexBySource: new Map(),
      mapping: [],
      metrics: { affectedVoxels: 0, changedVoxels: 0, lockedVoxels: 0, sourceColors: 0, targetColorsUsed: 0, paletteSizeBefore: model.palette.length, paletteSizeAfter: model.palette.length, meanColorMovement: 0, capacityFallbacks: 0 },
      warnings: options.scope === 'selection' ? ['The selection no longer contains any voxels.'] : [],
    };
  }
  const mode = options.mode ?? 'tonal';
  return options.scope === 'selection' && selection
    ? planSelection(model, targets, sources, selection, locked, mode)
    : planWholeModel(model, targets, sources, locked, mode);
}

export function applyPaletteRemapPlan(model: VoxelModel, plan: PaletteRemapPlan): VoxelModel {
  if (!plan.metrics.changedVoxels) return model;
  const voxels = model.voxels.map((voxel) => {
    if (plan.scope === 'selection' && !plan.selection?.has(packVoxelCoordinate(voxel))) return voxel;
    const colorIndex = plan.colorIndexBySource.get(voxel.colorIndex);
    if (colorIndex === undefined) return voxel;
    const color = plan.palette[colorIndex];
    return voxel.colorIndex === colorIndex && sameColor(voxel, color) ? voxel : { ...voxel, ...color, colorIndex };
  });
  return { ...model, palette: plan.palette, voxels };
}

export function remapVoxelPalette(model: VoxelModel, targetHexColors: string[], options: PaletteRemapOptions): PaletteRemapPreview {
  const plan = planVoxelPaletteRemap(model, targetHexColors, options);
  return {
    model: applyPaletteRemapPlan(model, plan),
    plan,
    mapping: plan.mapping,
    metrics: plan.metrics,
    warnings: plan.warnings,
  };
}
