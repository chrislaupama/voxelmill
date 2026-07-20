import type { RGB, VoxelModel } from '../types';
import {
  nearestPaletteIndex,
  oklabToRgb,
  perceptualColorDistance,
  rgbToOklab,
  rgbToOklch,
} from './palette';
import { hexToRgb, rgbToHex } from './aiPaletteContract';
import { packVoxelCoordinate } from './voxelIndex';

export type PaletteRemapMode = 'tonal' | 'appearance';
export type PaletteRemapScope = 'model' | 'selection';
export type PaletteContrastMode = 'readable' | 'exact';

export interface PaletteRemapOptions {
  scope: PaletteRemapScope;
  selection?: ReadonlySet<number>;
  lockedColors?: ReadonlySet<string>;
  mode?: PaletteRemapMode;
  contrast?: PaletteContrastMode;
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
  sourceFamilies: number;
  targetFamilies: number;
  familyMerges: number;
  toneOrderRetention: number;
  minimumColorSeparation: number;
  lightnessSpan: number;
  targetColorsRequested: number;
  targetColorsAccepted: number;
  nearDuplicateColorsRemoved: number;
  contrastAdjusted: boolean;
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
  /** Candidate swatches after the Readable/Exact preparation step. */
  preparedPalette: RGB[];
  /** Unique colors that scoped voxels will actually use after role mapping and fallbacks. */
  appliedPalette: RGB[];
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

interface ColorRoleEntry {
  id: number;
  color: RGB;
  weight: number;
  feature: ReturnType<typeof rgbToOklch>;
}

interface ColorFamily {
  id: string;
  kind: 'neutral' | 'chromatic';
  members: ColorRoleEntry[];
  weight: number;
  meanHue: number;
  meanChroma: number;
  meanLightness: number;
  lightnessSpan: number;
}

interface MappingQuality {
  sourceFamilies: number;
  targetFamilies: number;
  familyMerges: number;
  toneOrderRetention: number;
  warnings: string[];
}

interface SourceMappingResult extends MappingQuality {
  colors: Map<number, RGB>;
}

interface PreparedTargets {
  colors: RGB[];
  requested: number;
  removed: number;
  contrastAdjusted: boolean;
  warnings: string[];
}

const HARD_NEUTRAL_CHROMA = 0.025;
const CHROMATIC_ANCHOR_CHROMA = 0.05;
const MAX_HUE_FAMILY_SPAN = 68;
const MAX_HUE_FAMILY_DISTANCE = 48;
const MIN_TARGET_SEPARATION = 3.25;
const MIN_READABLE_LIGHTNESS_SPAN = 0.38;

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

const circularHueDistance = (left: number, right: number) => {
  const distance = Math.abs(left - right) % 360;
  return Math.min(distance, 360 - distance);
};

function colorLightnessSpan(colors: RGB[]) {
  if (colors.length < 2) return 0;
  const lightness = colors.map((color) => rgbToOklch(color).l);
  return Math.max(...lightness) - Math.min(...lightness);
}

function minimumSeparation(colors: RGB[]) {
  const unique = uniqueColors(colors);
  if (unique.length < 2) return 0;
  let minimum = Number.POSITIVE_INFINITY;
  for (let left = 0; left < unique.length; left += 1) {
    for (let right = left + 1; right < unique.length; right += 1) {
      minimum = Math.min(minimum, perceptualColorDistance(unique[left], unique[right]));
    }
  }
  return Number.isFinite(minimum) ? minimum : 0;
}

function prepareTargets(colors: RGB[], locked: ReadonlySet<string>, contrast: PaletteContrastMode): PreparedTargets {
  const requested = colors.length;
  if (contrast === 'exact' || colors.length < 2) {
    return { colors, requested, removed: 0, contrastAdjusted: false, warnings: [] };
  }

  const originalSpan = colorLightnessSpan(colors);
  let adjusted = colors.map((color) => ({ ...color }));
  let contrastAdjusted = false;
  if (originalSpan >= 0.02 && originalSpan < MIN_READABLE_LIGHTNESS_SPAN) {
    const features = adjusted.map((color) => rgbToOklab(color));
    const minimum = Math.min(...features.map((feature) => feature.l));
    const maximum = Math.max(...features.map((feature) => feature.l));
    const midpoint = (minimum + maximum) / 2;
    const targetMinimum = Math.max(0.06, Math.min(0.56, midpoint - MIN_READABLE_LIGHTNESS_SPAN / 2));
    const targetMaximum = Math.min(0.96, targetMinimum + MIN_READABLE_LIGHTNESS_SPAN);
    const scale = (targetMaximum - targetMinimum) / Math.max(0.001, maximum - minimum);
    adjusted = adjusted.map((color, index) => {
      if (locked.has(rgbToHex(color))) return color;
      const feature = features[index];
      return oklabToRgb({ ...feature, l: targetMinimum + (feature.l - minimum) * scale });
    });
    contrastAdjusted = true;
  }

  const lockedTargets = adjusted
    .filter((color) => locked.has(rgbToHex(color)))
    .sort((left, right) => rgbToHex(left).localeCompare(rgbToHex(right)));
  const unlockedTargets = adjusted
    .filter((color) => !locked.has(rgbToHex(color)))
    .sort((left, right) => {
      const leftFeature = rgbToOklch(left);
      const rightFeature = rgbToOklch(right);
      return leftFeature.l - rightFeature.l || leftFeature.h - rightFeature.h
        || leftFeature.c - rightFeature.c || rgbToHex(left).localeCompare(rgbToHex(right));
    });
  const kept = uniqueColors(lockedTargets);
  const rejected: RGB[] = [];
  for (const color of unlockedTargets) {
    if (kept.some((candidate) => perceptualColorDistance(color, candidate) < MIN_TARGET_SEPARATION)) rejected.push(color);
    else kept.push(color);
  }
  const minimumCount = Math.min(2, adjusted.length);
  while (kept.length < minimumCount && rejected.length) {
    let best = 0;
    let bestDistance = -1;
    for (let index = 0; index < rejected.length; index += 1) {
      const distance = kept.length
        ? Math.min(...kept.map((candidate) => perceptualColorDistance(rejected[index], candidate)))
        : Number.POSITIVE_INFINITY;
      if (distance > bestDistance || (distance === bestDistance && rgbToHex(rejected[index]) < rgbToHex(rejected[best]))) {
        best = index;
        bestDistance = distance;
      }
    }
    kept.push(rejected.splice(best, 1)[0]);
  }

  const warnings: string[] = [];
  const removed = requested - kept.length;
  if (removed) warnings.push(`Removed ${removed} near-duplicate candidate swatch${removed === 1 ? '' : 'es'} so adjacent tones remain distinguishable.`);
  if (contrastAdjusted) {
    warnings.push(`Expanded the candidate's lightness range from ${Math.round(originalSpan * 100)}% to ${Math.round(colorLightnessSpan(kept) * 100)}% for readable voxel shading.`);
  } else if (originalSpan < 0.02) {
    warnings.push('This candidate has almost no lightness range. Choose a different palette or add deeper shadows and clearer highlights.');
  }
  return { colors: kept, requested, removed, contrastAdjusted, warnings };
}

export function preparePaletteCandidate(
  targetHexColors: string[],
  lockedColors: ReadonlySet<string> = new Set<string>(),
  contrast: PaletteContrastMode = 'readable',
): RGB[] {
  const rawTargets = uniqueColors(targetHexColors.map((color) => hexToRgb(color)));
  if (!rawTargets.length) throw new Error('A palette candidate must contain at least one color.');
  return prepareTargets(rawTargets, lockedColors, contrast).colors;
}

function familyFromMembers(kind: ColorFamily['kind'], members: ColorRoleEntry[]): ColorFamily {
  const weight = members.reduce((sum, member) => sum + member.weight, 0);
  const weighted = (getValue: (member: ColorRoleEntry) => number) => (
    members.reduce((sum, member) => sum + getValue(member) * member.weight, 0) / Math.max(1, weight)
  );
  const sin = weighted((member) => Math.sin(member.feature.h * Math.PI / 180));
  const cos = weighted((member) => Math.cos(member.feature.h * Math.PI / 180));
  const lightness = members.map((member) => member.feature.l);
  const id = `${kind}:${members.map((member) => rgbToHex(member.color)).sort().join(',')}`;
  return {
    id,
    kind,
    members,
    weight,
    meanHue: (Math.atan2(sin, cos) * 180 / Math.PI + 360) % 360,
    meanChroma: weighted((member) => member.feature.c),
    meanLightness: weighted((member) => member.feature.l),
    lightnessSpan: Math.max(...lightness) - Math.min(...lightness),
  };
}

function inferColorFamilies(entries: ColorRoleEntry[]): ColorFamily[] {
  if (!entries.length) return [];
  const hardNeutrals = entries.filter((entry) => entry.feature.c < HARD_NEUTRAL_CHROMA);
  const intermediate = entries.filter((entry) => entry.feature.c >= HARD_NEUTRAL_CHROMA && entry.feature.c < CHROMATIC_ANCHOR_CHROMA);
  const anchors = entries.filter((entry) => entry.feature.c >= CHROMATIC_ANCHOR_CHROMA)
    .sort((left, right) => left.feature.h - right.feature.h || left.feature.l - right.feature.l || left.id - right.id);
  const chromaticGroups: ColorRoleEntry[][] = [];

  if (anchors.length) {
    let largestGapIndex = anchors.length - 1;
    let largestGap = (anchors[0].feature.h + 360) - anchors[anchors.length - 1].feature.h;
    for (let index = 0; index < anchors.length - 1; index += 1) {
      const gap = anchors[index + 1].feature.h - anchors[index].feature.h;
      if (gap > largestGap) {
        largestGap = gap;
        largestGapIndex = index;
      }
    }
    const ordered = [...anchors.slice(largestGapIndex + 1), ...anchors.slice(0, largestGapIndex + 1)];
    let previousHue = ordered[0].feature.h;
    let firstHue = previousHue;
    let group: ColorRoleEntry[] = [];
    for (const anchor of ordered) {
      let hue = anchor.feature.h;
      while (hue < previousHue) hue += 360;
      if (group.length && (hue - previousHue > MAX_HUE_FAMILY_DISTANCE || hue - firstHue > MAX_HUE_FAMILY_SPAN)) {
        chromaticGroups.push(group);
        group = [];
        firstHue = hue;
      }
      group.push(anchor);
      previousHue = hue;
    }
    if (group.length) chromaticGroups.push(group);
  }

  let chromaticFamilies = chromaticGroups.map((members) => familyFromMembers('chromatic', members));
  const neutralMembers: ColorRoleEntry[] = [];
  const attachToClosestChromaticFamily = (
    entry: ColorRoleEntry,
    maximumHueDistance: number,
    isEligible: (family: ColorFamily) => boolean = () => true,
  ) => {
    let closestIndex = -1;
    let closestDistance = Number.POSITIVE_INFINITY;
    for (let index = 0; index < chromaticFamilies.length; index += 1) {
      if (!isEligible(chromaticFamilies[index])) continue;
      const distance = circularHueDistance(entry.feature.h, chromaticFamilies[index].meanHue);
      if (distance < closestDistance) {
        closestDistance = distance;
        closestIndex = index;
      }
    }
    if (closestIndex >= 0 && closestDistance <= maximumHueDistance) {
      const members = [...chromaticFamilies[closestIndex].members, entry];
      chromaticFamilies[closestIndex] = familyFromMembers('chromatic', members);
      return true;
    }
    return false;
  };
  for (const entry of hardNeutrals) {
    // Dark and pale ends of a tinted ramp often lose chroma in sRGB. Reattach only
    // when their residual hue strongly agrees and they extend a ramp endpoint;
    // otherwise cool-grey weapon bodies could be swallowed by a cyan accent ramp.
    const attached = entry.feature.c >= 0.012 && attachToClosestChromaticFamily(entry, 36, (family) => {
      const lightness = family.members.map((member) => member.feature.l);
      return entry.weight <= family.weight * 1.25
        && (entry.feature.l < Math.min(...lightness) - 0.045 || entry.feature.l > Math.max(...lightness) + 0.045);
    });
    if (!attached) neutralMembers.push(entry);
  }
  for (const entry of intermediate) {
    if (!attachToClosestChromaticFamily(entry, MAX_HUE_FAMILY_SPAN)) neutralMembers.push(entry);
  }

  const families = neutralMembers.length ? [familyFromMembers('neutral', neutralMembers), ...chromaticFamilies] : chromaticFamilies;
  return families.sort((left, right) => {
    if (left.kind !== right.kind) return left.kind === 'neutral' ? -1 : 1;
    return right.weight - left.weight || left.meanHue - right.meanHue || left.id.localeCompare(right.id);
  });
}

function rankBy(families: ColorFamily[], score: (family: ColorFamily) => number) {
  const scores = [...new Set(families.map(score))].sort((left, right) => right - left);
  return new Map(families.map((family) => {
    const index = scores.indexOf(score(family));
    return [family.id, scores.length === 1 ? 0 : index / (scores.length - 1)];
  }));
}

function pairFamilies(sourceFamilies: ColorFamily[], targetFamilies: ColorFamily[], mode: PaletteRemapMode) {
  const result = new Map<string, ColorFamily>();
  if (!sourceFamilies.length || !targetFamilies.length) return result;
  const sourceProminence = rankBy(sourceFamilies, (family) => family.weight);
  const targetProminence = rankBy(targetFamilies, (family) => family.weight);
  const sourceWeight = sourceFamilies.reduce((sum, family) => sum + family.weight, 0);
  const targetWeight = targetFamilies.reduce((sum, family) => sum + family.weight, 0);
  const energy = (family: ColorFamily, totalWeight: number) => (
    family.meanChroma * (0.35 + family.meanLightness) / Math.sqrt(Math.max(0.02, family.weight / totalWeight))
  );
  const sourceEnergy = rankBy(sourceFamilies, (family) => energy(family, sourceWeight));
  const targetEnergy = rankBy(targetFamilies, (family) => energy(family, targetWeight));
  const available = new Set(targetFamilies.map((family) => family.id));
  const orderedSources = [...sourceFamilies].sort((left, right) => right.weight - left.weight || left.id.localeCompare(right.id));

  for (const source of orderedSources) {
    const candidates = targetFamilies.filter((target) => available.has(target.id));
    const pool = candidates.length ? candidates : targetFamilies;
    let best = pool[0];
    let bestCost = Number.POSITIVE_INFINITY;
    for (const target of pool) {
      const kindPenalty = source.kind === target.kind ? 0 : 4;
      const prominenceCost = Math.abs((sourceProminence.get(source.id) ?? 0) - (targetProminence.get(target.id) ?? 0)) * 1.8;
      const energyCost = Math.abs((sourceEnergy.get(source.id) ?? 0) - (targetEnergy.get(target.id) ?? 0)) * 0.85;
      const hueCost = source.kind === 'chromatic' && target.kind === 'chromatic'
        ? circularHueDistance(source.meanHue, target.meanHue) / 180 * (mode === 'appearance' ? 1.8 : 0.18)
        : 0;
      const rangeCost = Math.abs(source.lightnessSpan - target.lightnessSpan) * 0.25;
      const cost = kindPenalty + prominenceCost + energyCost + hueCost + rangeCost;
      if (cost < bestCost || (cost === bestCost && target.id < best.id)) {
        best = target;
        bestCost = cost;
      }
    }
    result.set(source.id, best);
    available.delete(best.id);
  }
  return result;
}

function toneOrderRetention(families: ColorFamily[], sources: SourceEntry[], mapping: Map<number, RGB>) {
  const sourceByIndex = new Map(sources.map((source) => [source.index, source]));
  let retained = 0;
  let total = 0;
  for (const family of families) {
    const mapped = family.members
      .map((member) => ({ source: sourceByIndex.get(member.id), after: mapping.get(member.id) }))
      .filter((entry): entry is { source: SourceEntry; after: RGB } => Boolean(entry.source && entry.after));
    for (let left = 0; left < mapped.length; left += 1) {
      for (let right = left + 1; right < mapped.length; right += 1) {
        const before = rgbToOklch(mapped[left].source.color).l - rgbToOklch(mapped[right].source.color).l;
        if (Math.abs(before) < 0.005) continue;
        const after = rgbToOklch(mapped[left].after).l - rgbToOklch(mapped[right].after).l;
        const weight = Math.sqrt(mapped[left].source.count * mapped[right].source.count);
        total += weight;
        if (before * after > 0) retained += weight;
        else if (Math.abs(after) < 0.005) retained += weight * 0.5;
      }
    }
  }
  return total ? retained / total * 100 : 100;
}

function roleAwareMapping(
  sources: SourceEntry[],
  contextSources: SourceEntry[],
  targets: RGB[],
  mode: PaletteRemapMode,
): SourceMappingResult {
  const mapping = new Map<number, RGB>();
  if (!sources.length || !targets.length) {
    return { colors: mapping, sourceFamilies: 0, targetFamilies: 0, familyMerges: 0, toneOrderRetention: 100, warnings: [] };
  }
  const unlockedContext = contextSources.filter((entry) => !entry.locked);
  const sourceFamilies = inferColorFamilies(unlockedContext.map((entry) => ({
    id: entry.index, color: entry.color, weight: entry.count, feature: rgbToOklch(entry.color),
  })));
  const targetFamilies = inferColorFamilies(targets.map((color, index) => ({
    id: index, color, weight: 1, feature: rgbToOklch(color),
  })));
  const familyPairs = pairFamilies(sourceFamilies, targetFamilies, mode);
  const sourceFamilyByIndex = new Map<number, ColorFamily>();
  for (const family of sourceFamilies) for (const member of family.members) sourceFamilyByIndex.set(member.id, family);
  const allSourceLightness = unlockedContext.map((entry) => rgbToOklch(entry.color).l);
  const globalMinimum = Math.min(...allSourceLightness);
  const globalSpan = Math.max(...allSourceLightness) - globalMinimum;

  for (const source of sources) {
    if (source.locked) {
      mapping.set(source.index, source.color);
      continue;
    }
    const family = sourceFamilyByIndex.get(source.index);
    const targetFamily = family ? familyPairs.get(family.id) : undefined;
    if (!family || !targetFamily) {
      mapping.set(source.index, targets[nearestPaletteIndex(source.color, targets)]);
      continue;
    }
    const sourceRamp = [...family.members].sort((left, right) => left.feature.l - right.feature.l
      || left.feature.c - right.feature.c || left.feature.h - right.feature.h || left.id - right.id);
    const targetRamp = [...targetFamily.members].sort((left, right) => left.feature.l - right.feature.l
      || left.feature.c - right.feature.c || left.feature.h - right.feature.h || left.id - right.id);
    const sourcePosition = sourceRamp.findIndex((member) => member.id === source.index);
    const normalized = sourceRamp.length > 1
      ? sourcePosition / (sourceRamp.length - 1)
      : globalSpan > 0.001 ? (rgbToOklch(source.color).l - globalMinimum) / globalSpan : 0.5;
    const targetIndex = Math.round(normalized * (targetRamp.length - 1));
    mapping.set(source.index, targetRamp[Math.max(0, targetIndex)].color);
  }

  const distinctTargets = new Set(familyPairs.values());
  const familyMerges = Math.max(0, sourceFamilies.length - distinctTargets.size);
  const unusedTargets = Math.max(0, targetFamilies.length - distinctTargets.size);
  const warnings: string[] = [];
  if (familyMerges) warnings.push(`${familyMerges} source material ramp${familyMerges === 1 ? '' : 's'} share a target ramp because this candidate has fewer coherent color families.`);
  if (unusedTargets) warnings.push(`${unusedTargets} unrelated candidate color ramp${unusedTargets === 1 ? ' was' : 's were'} excluded instead of mixing hues across source materials.`);
  return {
    colors: mapping,
    sourceFamilies: sourceFamilies.length,
    targetFamilies: targetFamilies.length,
    familyMerges,
    toneOrderRetention: toneOrderRetention(sourceFamilies, sources, mapping),
    warnings,
  };
}

function mapSources(sources: SourceEntry[], contextSources: SourceEntry[], targets: RGB[], mode: PaletteRemapMode) {
  const result = roleAwareMapping(sources, contextSources, targets, mode);
  for (const entry of sources) if (entry.locked) result.colors.set(entry.index, entry.color);
  return result;
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
  const unlocked = mapping.filter((entry) => !entry.locked);
  const total = unlocked.reduce((sum, entry) => sum + entry.voxelCount, 0);
  if (!total) return 0;
  return unlocked.reduce((sum, entry) => sum + perceptualColorDistance(entry.before, entry.after) * entry.voxelCount, 0) / total;
}

function planWholeModel(
  model: VoxelModel,
  targets: RGB[],
  sources: SourceEntry[],
  contextSources: SourceEntry[],
  locked: ReadonlySet<string>,
  mode: PaletteRemapMode,
  prepared: PreparedTargets,
): PaletteRemapPlan {
  const lockedColors = model.palette.filter((color) => locked.has(rgbToHex(color)));
  const unlockedTargets = targets.filter((color) => !locked.has(rgbToHex(color)));
  const mapResult = mapSources(sources, contextSources, unlockedTargets.length ? unlockedTargets : targets, mode);
  const mappedColors = mapResult.colors;
  const palette = uniqueColors([
    ...lockedColors,
    ...sources.map((source) => mappedColors.get(source.index) ?? source.color),
  ]).slice(0, 255);
  const paletteIndices = new Map(palette.map((color, index) => [rgbToHex(color), index]));
  const colorIndexBySource = new Map<number, number>();
  for (const source of sources) {
    const colorIndex = paletteIndices.get(rgbToHex(mappedColors.get(source.index) ?? source.color));
    if (colorIndex !== undefined) colorIndexBySource.set(source.index, colorIndex);
  }
  const mapping = mappingSummary(sources, mappedColors);
  const colorsUsed = uniqueColors(mapping.map((entry) => entry.after));
  const changedVoxels = sources.reduce((count, source) => {
    const colorIndex = colorIndexBySource.get(source.index);
    const color = colorIndex === undefined ? source.color : palette[colorIndex];
    return count + (sameColor(source.color, color) ? 0 : source.count);
  }, 0);
  return {
    scope: 'model',
    palette,
    preparedPalette: targets,
    appliedPalette: colorsUsed,
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
      sourceFamilies: mapResult.sourceFamilies,
      targetFamilies: mapResult.targetFamilies,
      familyMerges: mapResult.familyMerges,
      toneOrderRetention: mapResult.toneOrderRetention,
      minimumColorSeparation: minimumSeparation(colorsUsed),
      lightnessSpan: colorLightnessSpan(colorsUsed),
      targetColorsRequested: prepared.requested,
      targetColorsAccepted: targets.length,
      nearDuplicateColorsRemoved: prepared.removed,
      contrastAdjusted: prepared.contrastAdjusted,
    },
    warnings: [...prepared.warnings, ...mapResult.warnings],
  };
}

function planSelection(
  model: VoxelModel,
  targets: RGB[],
  sources: SourceEntry[],
  contextSources: SourceEntry[],
  selection: ReadonlySet<number>,
  locked: ReadonlySet<string>,
  mode: PaletteRemapMode,
  prepared: PreparedTargets,
): PaletteRemapPlan {
  const unlockedTargets = targets.filter((color) => !locked.has(rgbToHex(color)));
  const mapResult = mapSources(sources, contextSources, unlockedTargets.length ? unlockedTargets : targets, mode);
  const requestedColors = mapResult.colors;
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
  const colorsUsed = uniqueColors(mapping.map((entry) => entry.after));
  const changedVoxels = sources.reduce((count, source) => {
    const colorIndex = targetIndices.get(source.index);
    const color = colorIndex === undefined ? source.color : palette[colorIndex];
    return count + (sameColor(source.color, color) ? 0 : source.count);
  }, 0);
  const capacityWarnings = capacityFallbacks
    ? [`${capacityFallbacks} requested color${capacityFallbacks === 1 ? '' : 's'} used the closest protected swatch because the 255-color palette is full.`]
    : [];
  return {
    scope: 'selection',
    selection,
    palette,
    preparedPalette: targets,
    appliedPalette: colorsUsed,
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
      sourceFamilies: mapResult.sourceFamilies,
      targetFamilies: mapResult.targetFamilies,
      familyMerges: mapResult.familyMerges,
      toneOrderRetention: mapResult.toneOrderRetention,
      minimumColorSeparation: minimumSeparation(colorsUsed),
      lightnessSpan: colorLightnessSpan(colorsUsed),
      targetColorsRequested: prepared.requested,
      targetColorsAccepted: targets.length,
      nearDuplicateColorsRemoved: prepared.removed,
      contrastAdjusted: prepared.contrastAdjusted,
    },
    warnings: [...prepared.warnings, ...mapResult.warnings, ...capacityWarnings],
  };
}

export function planVoxelPaletteRemap(model: VoxelModel, targetHexColors: string[], options: PaletteRemapOptions): PaletteRemapPlan {
  const locked = options.lockedColors ?? new Set<string>();
  const rawTargets = uniqueColors(targetHexColors.map((color) => hexToRgb(color)));
  if (rawTargets.length < 1) throw new Error('A palette candidate must contain at least one color.');
  const prepared = prepareTargets(rawTargets, locked, options.contrast ?? 'readable');
  const targets = prepared.colors;
  const selection = options.scope === 'selection' ? options.selection ?? new Set<number>() : undefined;
  const sources = sourceEntries(model, selection, locked);
  const contextSources = options.scope === 'selection' ? sourceEntries(model, undefined, locked) : sources;
  if (!sources.length) {
    return {
      scope: options.scope,
      selection,
      palette: model.palette,
      preparedPalette: targets,
      appliedPalette: [],
      colorIndexBySource: new Map(),
      mapping: [],
      metrics: {
        affectedVoxels: 0,
        changedVoxels: 0,
        lockedVoxels: 0,
        sourceColors: 0,
        targetColorsUsed: 0,
        paletteSizeBefore: model.palette.length,
        paletteSizeAfter: model.palette.length,
        meanColorMovement: 0,
        capacityFallbacks: 0,
        sourceFamilies: 0,
        targetFamilies: 0,
        familyMerges: 0,
        toneOrderRetention: 100,
        minimumColorSeparation: 0,
        lightnessSpan: 0,
        targetColorsRequested: prepared.requested,
        targetColorsAccepted: targets.length,
        nearDuplicateColorsRemoved: prepared.removed,
        contrastAdjusted: prepared.contrastAdjusted,
      },
      warnings: options.scope === 'selection' ? ['The selection no longer contains any voxels.'] : [],
    };
  }
  const mode = options.mode ?? 'tonal';
  return options.scope === 'selection' && selection
    ? planSelection(model, targets, sources, contextSources, selection, locked, mode, prepared)
    : planWholeModel(model, targets, sources, contextSources, locked, mode, prepared);
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
