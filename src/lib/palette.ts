import type { RGB } from '../types';

interface Lab {
  l: number;
  a: number;
  b: number;
}

interface WeightedColor extends RGB {
  count: number;
  lab: Lab;
}

interface ColorBox {
  colors: WeightedColor[];
  weight: number;
}

const paletteLabCache = new WeakMap<RGB[], Lab[]>();

export const srgbToLinear = (value: number) => {
  const normalized = value > 1 ? value / 255 : value;
  return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
};

export const linearToSrgb = (value: number) => {
  const clamped = Math.max(0, Math.min(1, value));
  const encoded = clamped <= 0.0031308 ? clamped * 12.92 : 1.055 * clamped ** (1 / 2.4) - 0.055;
  return Math.round(encoded * 255);
};

function rgbToOklab(color: RGB): Lab {
  const r = srgbToLinear(color.r);
  const g = srgbToLinear(color.g);
  const b = srgbToLinear(color.b);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return {
    l: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    a: 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    b: 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  };
}

function oklabToRgb(lab: Lab): RGB {
  const lRoot = lab.l + 0.3963377774 * lab.a + 0.2158037573 * lab.b;
  const mRoot = lab.l - 0.1055613458 * lab.a - 0.0638541728 * lab.b;
  const sRoot = lab.l - 0.0894841775 * lab.a - 1.291485548 * lab.b;
  const l = lRoot ** 3;
  const m = mRoot ** 3;
  const s = sRoot ** 3;
  return {
    r: linearToSrgb(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    g: linearToSrgb(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    b: linearToSrgb(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  };
}

const labRange = (colors: WeightedColor[], channel: keyof Lab) => {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const color of colors) {
    min = Math.min(min, color.lab[channel]);
    max = Math.max(max, color.lab[channel]);
  }
  return max - min;
};

const labDistance = (a: Lab, b: Lab) => {
  const dl = (a.l - b.l) * 1.15;
  const da = a.a - b.a;
  const db = a.b - b.b;
  return dl * dl + da * da + db * db;
};

function averageLab(colors: WeightedColor[], weight: number): Lab {
  let l = 0;
  let a = 0;
  let b = 0;
  for (const color of colors) {
    l += color.lab.l * color.count;
    a += color.lab.a * color.count;
    b += color.lab.b * color.count;
  }
  return { l: l / weight, a: a / weight, b: b / weight };
}

function initialCentroids(entries: WeightedColor[], targetSize: number): Lab[] {
  const boxes: ColorBox[] = [{ colors: entries, weight: entries.reduce((sum, color) => sum + color.count, 0) }];
  while (boxes.length < targetSize) {
    let splitIndex = -1;
    let bestScore = -1;
    for (let i = 0; i < boxes.length; i += 1) {
      const box = boxes[i];
      if (box.colors.length < 2) continue;
      const range = Math.max(
        labRange(box.colors, 'l') * 1.15,
        labRange(box.colors, 'a'),
        labRange(box.colors, 'b'),
      );
      const score = range * Math.sqrt(box.weight);
      if (score > bestScore) {
        bestScore = score;
        splitIndex = i;
      }
    }
    if (splitIndex < 0) break;

    const box = boxes[splitIndex];
    const ranges = {
      l: labRange(box.colors, 'l') * 1.15,
      a: labRange(box.colors, 'a'),
      b: labRange(box.colors, 'b'),
    };
    const channel = (Object.keys(ranges) as (keyof Lab)[]).sort((a, b) => ranges[b] - ranges[a])[0];
    box.colors.sort((a, b) => a.lab[channel] - b.lab[channel]);
    let running = 0;
    let pivot = 1;
    for (; pivot < box.colors.length; pivot += 1) {
      running += box.colors[pivot - 1].count;
      if (running >= box.weight / 2) break;
    }
    const left = box.colors.slice(0, pivot);
    const right = box.colors.slice(pivot);
    const leftWeight = left.reduce((sum, color) => sum + color.count, 0);
    boxes.splice(
      splitIndex,
      1,
      { colors: left, weight: leftWeight },
      { colors: right, weight: box.weight - leftWeight },
    );
  }
  return boxes.map((box) => averageLab(box.colors, box.weight));
}

export function buildPalette(colors: RGB[], targetSize: number): RGB[] {
  const histogram = new Map<number, WeightedColor>();
  for (const color of colors) {
    // Six bits per channel keeps far more texture nuance than the old five-bit buckets.
    const r6 = Math.min(63, color.r >> 2);
    const g6 = Math.min(63, color.g >> 2);
    const b6 = Math.min(63, color.b >> 2);
    const key = (r6 << 12) | (g6 << 6) | b6;
    const existing = histogram.get(key);
    if (existing) {
      existing.count += 1;
    } else {
      const rgb = { r: r6 * 4 + 2, g: g6 * 4 + 2, b: b6 * 4 + 2 };
      histogram.set(key, { ...rgb, count: 1, lab: rgbToOklab(rgb) });
    }
  }

  const entries = [...histogram.values()];
  if (entries.length <= targetSize) return entries.map(({ r, g, b }) => ({ r, g, b }));
  let centroids = initialCentroids(entries, targetSize);

  // Weighted Lloyd iterations in OKLab make each final swatch perceptually representative.
  for (let iteration = 0; iteration < 10; iteration += 1) {
    const sums = centroids.map(() => ({ l: 0, a: 0, b: 0, weight: 0 }));
    for (const color of entries) {
      let bestIndex = 0;
      let bestDistance = Number.POSITIVE_INFINITY;
      for (let index = 0; index < centroids.length; index += 1) {
        const distance = labDistance(color.lab, centroids[index]);
        if (distance < bestDistance) {
          bestDistance = distance;
          bestIndex = index;
        }
      }
      const sum = sums[bestIndex];
      sum.l += color.lab.l * color.count;
      sum.a += color.lab.a * color.count;
      sum.b += color.lab.b * color.count;
      sum.weight += color.count;
    }
    centroids = centroids.map((centroid, index) => {
      const sum = sums[index];
      return sum.weight
        ? { l: sum.l / sum.weight, a: sum.a / sum.weight, b: sum.b / sum.weight }
        : centroid;
    });
  }

  return centroids.map(oklabToRgb);
}

export function nearestPaletteIndex(color: RGB, palette: RGB[]): number {
  const source = rgbToOklab(color);
  let paletteLabs = paletteLabCache.get(palette);
  if (!paletteLabs) {
    paletteLabs = palette.map(rgbToOklab);
    paletteLabCache.set(palette, paletteLabs);
  }
  let bestIndex = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let i = 0; i < palette.length; i += 1) {
    const distance = labDistance(source, paletteLabs[i]);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = i;
    }
  }
  return bestIndex;
}
