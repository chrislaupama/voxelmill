import type { RGB, VoxelModel } from '../types';

const sameColor = (a: RGB, b: RGB) => a.r === b.r && a.g === b.g && a.b === b.b;

function remapPalette(model: VoxelModel, order: number[]): VoxelModel {
  const indexMap = new Map(order.map((oldIndex, newIndex) => [oldIndex, newIndex]));
  return {
    ...model,
    palette: order.map((index) => model.palette[index]),
    voxels: model.voxels.map((voxel) => {
      const colorIndex = indexMap.get(voxel.colorIndex);
      if (colorIndex === undefined) return voxel;
      const color = model.palette[order[colorIndex]];
      return { ...voxel, ...color, colorIndex };
    }),
  };
}

export function compactPalette(model: VoxelModel): VoxelModel {
  if (!model.voxels.length) {
    if (model.palette.length === 1) return model;
    return {
      ...model,
      palette: [model.palette[0] ?? { r: 0, g: 0, b: 0 }],
    };
  }
  const used = new Set(model.voxels.map((voxel) => voxel.colorIndex));
  const order = model.palette.map((_, index) => index).filter((index) => used.has(index));
  return order.length === model.palette.length ? model : remapPalette(model, order);
}

const luminance = (color: RGB) => 0.2126 * color.r + 0.7152 * color.g + 0.0722 * color.b;

const hue = (color: RGB) => {
  const r = color.r / 255;
  const g = color.g / 255;
  const b = color.b / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max === min) return -1;
  const delta = max - min;
  const sector = max === r ? ((g - b) / delta) % 6 : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4;
  return (sector * 60 + 360) % 360;
};

export function sortPalette(model: VoxelModel, mode: 'luminance' | 'hue'): VoxelModel {
  const score = mode === 'luminance' ? luminance : hue;
  const order = model.palette.map((_, index) => index).sort((a, b) => score(model.palette[a]) - score(model.palette[b]));
  if (order.every((oldIndex, newIndex) => oldIndex === newIndex)) return model;
  return remapPalette(model, order);
}

export function replacePaletteColor(model: VoxelModel, index: number, color: RGB): VoxelModel {
  if (!model.palette[index]) return model;
  const existingIndex = model.palette.findIndex((candidate, candidateIndex) => candidateIndex !== index && sameColor(candidate, color));
  if (existingIndex >= 0) {
    const palette = model.palette.filter((_, candidateIndex) => candidateIndex !== index);
    const mergedIndex = existingIndex > index ? existingIndex - 1 : existingIndex;
    const voxels = model.voxels.map((voxel) => {
      const colorIndex = voxel.colorIndex === index ? mergedIndex : voxel.colorIndex > index ? voxel.colorIndex - 1 : voxel.colorIndex;
      const resolved = palette[colorIndex];
      return { ...voxel, ...resolved, colorIndex };
    });
    return { ...model, palette, voxels };
  }
  if (sameColor(model.palette[index], color)) return model;
  const palette = [...model.palette];
  palette[index] = color;
  return {
    ...model,
    palette,
    voxels: model.voxels.map((voxel) => voxel.colorIndex === index ? { ...voxel, ...color } : voxel),
  };
}
