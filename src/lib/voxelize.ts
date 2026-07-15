import {
  Box3,
  Color,
  Mesh,
  MeshStandardMaterial,
  SRGBColorSpace,
  SkinnedMesh,
  Triangle,
  Vector2,
  Vector3,
  type BufferAttribute,
  type Material,
  type Texture,
} from 'three';
import type { ProgressUpdate, RGB, SourceModel, VoxelModel, VoxelizeOptions } from '../types';
import { buildPalette, linearToSrgb, nearestPaletteIndex, srgbToLinear } from './palette';

interface AccumulatedColor {
  r: number;
  g: number;
  b: number;
  count: number;
}

interface TexturePixels {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

type ProgressCallback = (update: ProgressUpdate) => void;

const textureCache = new WeakMap<Texture, TexturePixels | null>();
const workingVertexColor = new Color();
const workingUv = new Vector2();
const barycentric = new Vector3();
const closest = new Vector3();
const sampleProbe = new Vector3();
const cellBox = new Box3();
const center = new Vector3();

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function getTexturePixels(texture: Texture): TexturePixels | null {
  const cached = textureCache.get(texture);
  if (cached !== undefined) return cached;
  const image = texture.image as CanvasImageSource & { width?: number; height?: number };
  const sourceWidth = image?.width ?? 0;
  const sourceHeight = image?.height ?? 0;
  if (!image || !sourceWidth || !sourceHeight) {
    textureCache.set(texture, null);
    return null;
  }

  // A bounded sampling canvas avoids retaining a 4K/8K image-sized pixel buffer.
  const scale = Math.min(1, 2048 / Math.max(sourceWidth, sourceHeight));
  const width = Math.max(1, Math.round(sourceWidth * scale));
  const height = Math.max(1, Math.round(sourceHeight * scale));
  const canvas = typeof OffscreenCanvas !== 'undefined'
    ? new OffscreenCanvas(width, height)
    : typeof document !== 'undefined'
      ? document.createElement('canvas')
      : null;
  if (!canvas) return null;
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) return null;
  try {
    context.drawImage(image, 0, 0, width, height);
    const pixels = { data: context.getImageData(0, 0, width, height).data, width, height };
    textureCache.set(texture, pixels);
    return pixels;
  } catch {
    textureCache.set(texture, null);
    return null;
  }
}

function sampleTexture(texture: Texture, uv: Vector2): [number, number, number, number] | null {
  const pixels = getTexturePixels(texture);
  if (!pixels) return null;
  workingUv.copy(uv);
  if (texture.matrixAutoUpdate) texture.updateMatrix();
  texture.transformUv(workingUv);
  const u = clamp(workingUv.x, 0, 1);
  // transformUv() already applies the texture's flipY convention. Its result is
  // in source-image coordinates, where row zero is the top of the decoded image.
  const v = clamp(workingUv.y, 0, 1);
  const pixelX = u * (pixels.width - 1);
  const pixelY = v * (pixels.height - 1);
  const x0 = Math.floor(pixelX);
  const y0 = Math.floor(pixelY);
  const x1 = Math.min(x0 + 1, pixels.width - 1);
  const y1 = Math.min(y0 + 1, pixels.height - 1);
  const tx = pixelX - x0;
  const ty = pixelY - y0;
  const result = [0, 0, 0, 0] as [number, number, number, number];
  for (let channel = 0; channel < 4; channel += 1) {
    const topLeft = pixels.data[(y0 * pixels.width + x0) * 4 + channel];
    const topRight = pixels.data[(y0 * pixels.width + x1) * 4 + channel];
    const bottomLeft = pixels.data[(y1 * pixels.width + x0) * 4 + channel];
    const bottomRight = pixels.data[(y1 * pixels.width + x1) * 4 + channel];
    const top = topLeft + (topRight - topLeft) * tx;
    const bottom = bottomLeft + (bottomRight - bottomLeft) * tx;
    result[channel] = top + (bottom - top) * ty;
  }
  return result;
}

function materialAt(mesh: Mesh, elementOffset: number): Material {
  if (!Array.isArray(mesh.material)) return mesh.material;
  const group = mesh.geometry.groups.find(
    (candidate) => elementOffset >= candidate.start && elementOffset < candidate.start + candidate.count,
  );
  return mesh.material[group?.materialIndex ?? 0] ?? mesh.material[0];
}

function sampleColor(
  material: Material,
  uvAttribute: BufferAttribute | undefined,
  colorAttribute: BufferAttribute | undefined,
  aIndex: number,
  bIndex: number,
  cIndex: number,
  weights: Vector3,
): { color: RGB; alpha: number } {
  const coloredMaterial = material as Material & {
    color?: Color;
    map?: Texture;
    opacity?: number;
    vertexColors?: boolean;
  };
  let r = 1;
  let g = 1;
  let b = 1;
  if (coloredMaterial.color) {
    // Three.js stores material colors in its linear working color space.
    r = coloredMaterial.color.r;
    g = coloredMaterial.color.g;
    b = coloredMaterial.color.b;
  }

  if (coloredMaterial.vertexColors && colorAttribute) {
    workingVertexColor.setRGB(
      colorAttribute.getX(aIndex) * weights.x + colorAttribute.getX(bIndex) * weights.y + colorAttribute.getX(cIndex) * weights.z,
      colorAttribute.getY(aIndex) * weights.x + colorAttribute.getY(bIndex) * weights.y + colorAttribute.getY(cIndex) * weights.z,
      colorAttribute.getZ(aIndex) * weights.x + colorAttribute.getZ(bIndex) * weights.y + colorAttribute.getZ(cIndex) * weights.z,
    );
    r *= workingVertexColor.r;
    g *= workingVertexColor.g;
    b *= workingVertexColor.b;
  }

  let alpha = (coloredMaterial.opacity ?? 1) * 255;
  if (coloredMaterial.map && uvAttribute) {
    const uv = new Vector2(
      uvAttribute.getX(aIndex) * weights.x + uvAttribute.getX(bIndex) * weights.y + uvAttribute.getX(cIndex) * weights.z,
      uvAttribute.getY(aIndex) * weights.x + uvAttribute.getY(bIndex) * weights.y + uvAttribute.getY(cIndex) * weights.z,
    );
    const texel = sampleTexture(coloredMaterial.map, uv);
    if (texel) {
      const textureIsSrgb = coloredMaterial.map.colorSpace === SRGBColorSpace;
      r *= textureIsSrgb ? srgbToLinear(texel[0]) : texel[0] / 255;
      g *= textureIsSrgb ? srgbToLinear(texel[1]) : texel[1] / 255;
      b *= textureIsSrgb ? srgbToLinear(texel[2]) : texel[2] / 255;
      alpha *= texel[3] / 255;
    }
  }
  return {
    color: { r: linearToSrgb(r), g: linearToSrgb(g), b: linearToSrgb(b) },
    alpha,
  };
}

function samplePointColor(
  triangle: Triangle,
  point: Vector3,
  material: Material,
  uvAttribute: BufferAttribute | undefined,
  colorAttribute: BufferAttribute | undefined,
  aIndex: number,
  bIndex: number,
  cIndex: number,
) {
  triangle.getBarycoord(point, barycentric);
  return sampleColor(material, uvAttribute, colorAttribute, aIndex, bIndex, cIndex, barycentric);
}

function vertexWorldPosition(mesh: Mesh, vertexIndex: number, target: Vector3) {
  const position = mesh.geometry.attributes.position;
  target.fromBufferAttribute(position, vertexIndex);
  if (mesh instanceof SkinnedMesh) mesh.applyBoneTransform(vertexIndex, target);
  target.applyMatrix4(mesh.matrixWorld);
}

function enqueueBoundary(
  state: Uint8Array,
  queue: Int32Array,
  tail: number,
  x: number,
  y: number,
  z: number,
  sx: number,
  sy: number,
): number {
  const index = x + sx * (y + sy * z);
  if (state[index] !== 0) return tail;
  state[index] = 2;
  queue[tail] = index;
  return tail + 1;
}

function solidFill(
  state: Uint8Array,
  red: Uint8Array,
  green: Uint8Array,
  blue: Uint8Array,
  sx: number,
  sy: number,
  sz: number,
) {
  const total = state.length;
  const queue = new Int32Array(total);
  let tail = 0;
  for (let z = 0; z < sz; z += 1) {
    for (let y = 0; y < sy; y += 1) {
      tail = enqueueBoundary(state, queue, tail, 0, y, z, sx, sy);
      tail = enqueueBoundary(state, queue, tail, sx - 1, y, z, sx, sy);
    }
  }
  for (let z = 0; z < sz; z += 1) {
    for (let x = 0; x < sx; x += 1) {
      tail = enqueueBoundary(state, queue, tail, x, 0, z, sx, sy);
      tail = enqueueBoundary(state, queue, tail, x, sy - 1, z, sx, sy);
    }
  }
  for (let y = 0; y < sy; y += 1) {
    for (let x = 0; x < sx; x += 1) {
      tail = enqueueBoundary(state, queue, tail, x, y, 0, sx, sy);
      tail = enqueueBoundary(state, queue, tail, x, y, sz - 1, sx, sy);
    }
  }

  const neighbors = [1, -1, sx, -sx, sx * sy, -sx * sy];
  let head = 0;
  while (head < tail) {
    const current = queue[head++];
    const z = Math.floor(current / (sx * sy));
    const remainder = current - z * sx * sy;
    const y = Math.floor(remainder / sx);
    const x = remainder - y * sx;
    for (let direction = 0; direction < 6; direction += 1) {
      if ((direction === 0 && x === sx - 1) || (direction === 1 && x === 0)) continue;
      if ((direction === 2 && y === sy - 1) || (direction === 3 && y === 0)) continue;
      if ((direction === 4 && z === sz - 1) || (direction === 5 && z === 0)) continue;
      const next = current + neighbors[direction];
      if (state[next] === 0) {
        state[next] = 2;
        queue[tail++] = next;
      }
    }
  }

  // Propagate the nearest surface color through interior-only cells.
  head = 0;
  tail = 0;
  for (let i = 0; i < total; i += 1) {
    if (state[i] === 1) queue[tail++] = i;
  }
  while (head < tail) {
    const current = queue[head++];
    const z = Math.floor(current / (sx * sy));
    const remainder = current - z * sx * sy;
    const y = Math.floor(remainder / sx);
    const x = remainder - y * sx;
    for (let direction = 0; direction < 6; direction += 1) {
      if ((direction === 0 && x === sx - 1) || (direction === 1 && x === 0)) continue;
      if ((direction === 2 && y === sy - 1) || (direction === 3 && y === 0)) continue;
      if ((direction === 4 && z === sz - 1) || (direction === 5 && z === 0)) continue;
      const next = current + neighbors[direction];
      if (state[next] === 0) {
        state[next] = 3;
        red[next] = red[current];
        green[next] = green[current];
        blue[next] = blue[current];
        queue[tail++] = next;
      }
    }
  }
}

const nextFrame = () => new Promise<void>((resolve) => {
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => resolve());
  else setTimeout(resolve, 0);
});

export async function voxelizeModel(
  source: SourceModel,
  options: VoxelizeOptions,
  onProgress: ProgressCallback,
): Promise<VoxelModel> {
  source.scene.updateMatrixWorld(true);
  const bounds = new Box3().setFromObject(source.scene);
  if (bounds.isEmpty()) throw new Error('The GLB does not contain any visible geometry.');
  const extent = bounds.getSize(new Vector3());
  const maxExtent = Math.max(extent.x, extent.y, extent.z);
  if (maxExtent <= 0) throw new Error('The model has zero size.');

  const voxelSize = maxExtent / options.resolution;
  const origin = bounds.min.clone().addScalar(-voxelSize);
  const sx = clamp(Math.ceil(extent.x / voxelSize) + 2, 1, 255);
  const sy = clamp(Math.ceil(extent.y / voxelSize) + 2, 1, 255);
  const sz = clamp(Math.ceil(extent.z / voxelSize) + 2, 1, 255);
  const totalCells = sx * sy * sz;
  const accumulated = new Map<number, AccumulatedColor>();
  const meshes: Mesh[] = [];
  source.scene.traverse((object) => {
    if (object instanceof Mesh && object.visible && object.geometry.attributes.position) meshes.push(object);
  });

  const triangle = new Triangle(new Vector3(), new Vector3(), new Vector3());
  const triangleBounds = new Box3();
  let processedTriangles = 0;
  let operations = 0;
  onProgress({ progress: 0.04, label: 'Reading mesh geometry' });

  for (const mesh of meshes) {
    const geometry = mesh.geometry;
    const index = geometry.index;
    const elementCount = index?.count ?? geometry.attributes.position.count;
    const colorAttribute = geometry.attributes.color as BufferAttribute | undefined;

    for (let elementOffset = 0; elementOffset + 2 < elementCount; elementOffset += 3) {
      const aIndex = index?.getX(elementOffset) ?? elementOffset;
      const bIndex = index?.getX(elementOffset + 1) ?? elementOffset + 1;
      const cIndex = index?.getX(elementOffset + 2) ?? elementOffset + 2;
      vertexWorldPosition(mesh, aIndex, triangle.a);
      vertexWorldPosition(mesh, bIndex, triangle.b);
      vertexWorldPosition(mesh, cIndex, triangle.c);
      triangleBounds.setFromPoints([triangle.a, triangle.b, triangle.c]);

      const minX = clamp(Math.floor((triangleBounds.min.x - origin.x) / voxelSize), 0, sx - 1);
      const minY = clamp(Math.floor((triangleBounds.min.y - origin.y) / voxelSize), 0, sy - 1);
      const minZ = clamp(Math.floor((triangleBounds.min.z - origin.z) / voxelSize), 0, sz - 1);
      const maxX = clamp(Math.floor((triangleBounds.max.x - origin.x) / voxelSize), 0, sx - 1);
      const maxY = clamp(Math.floor((triangleBounds.max.y - origin.y) / voxelSize), 0, sy - 1);
      const maxZ = clamp(Math.floor((triangleBounds.max.z - origin.z) / voxelSize), 0, sz - 1);
      const material = materialAt(mesh, elementOffset);
      const texture = (material as Material & { map?: Texture }).map;
      const uvChannel = texture?.channel ?? 0;
      const uvAttributeName = uvChannel === 0 ? 'uv' : `uv${uvChannel}`;
      const uv = geometry.attributes[uvAttributeName] as BufferAttribute | undefined;

      for (let z = minZ; z <= maxZ; z += 1) {
        for (let y = minY; y <= maxY; y += 1) {
          for (let x = minX; x <= maxX; x += 1) {
            const min = cellBox.min.set(origin.x + x * voxelSize, origin.y + y * voxelSize, origin.z + z * voxelSize);
            cellBox.max.set(min.x + voxelSize, min.y + voxelSize, min.z + voxelSize);
            if (!cellBox.intersectsTriangle(triangle)) continue;
            cellBox.getCenter(center);
            triangle.closestPointToPoint(center, closest);
            let sampled = samplePointColor(
              triangle,
              closest,
              material,
              uv,
              colorAttribute,
              aIndex,
              bIndex,
              cIndex,
            );
            let sampleR = 0;
            let sampleG = 0;
            let sampleB = 0;
            let sampleCount = 0;
            if (sampled.alpha >= options.alphaThreshold * 255) {
              sampleR += sampled.color.r;
              sampleG += sampled.color.g;
              sampleB += sampled.color.b;
              sampleCount += 1;
            }

            // Project the cell's eight corners onto the triangle. This approximates the
            // texture area covered by the voxel and prevents single-texel aliasing.
            if ((texture && uv) || ((material as Material & { vertexColors?: boolean }).vertexColors && colorAttribute)) {
              for (let cornerIndex = 0; cornerIndex < 8; cornerIndex += 1) {
                sampleProbe.set(
                  cornerIndex & 1 ? cellBox.max.x : cellBox.min.x,
                  cornerIndex & 2 ? cellBox.max.y : cellBox.min.y,
                  cornerIndex & 4 ? cellBox.max.z : cellBox.min.z,
                );
                triangle.closestPointToPoint(sampleProbe, closest);
                if (!cellBox.containsPoint(closest)) continue;
                sampled = samplePointColor(
                  triangle,
                  closest,
                  material,
                  uv,
                  colorAttribute,
                  aIndex,
                  bIndex,
                  cIndex,
                );
                if (sampled.alpha < options.alphaThreshold * 255) continue;
                sampleR += sampled.color.r;
                sampleG += sampled.color.g;
                sampleB += sampled.color.b;
                sampleCount += 1;
              }
            }
            if (!sampleCount) continue;
            const sampledColor = {
              r: sampleR / sampleCount,
              g: sampleG / sampleCount,
              b: sampleB / sampleCount,
            };
            const key = x + sx * (y + sy * z);
            const value = accumulated.get(key);
            if (value) {
              value.r += sampledColor.r;
              value.g += sampledColor.g;
              value.b += sampledColor.b;
              value.count += 1;
            } else {
              accumulated.set(key, { ...sampledColor, count: 1 });
            }
          }
        }
      }

      processedTriangles += 1;
      operations += (maxX - minX + 1) * (maxY - minY + 1) * (maxZ - minZ + 1);
      if (operations > 45_000) {
        operations = 0;
        onProgress({
          progress: 0.05 + 0.68 * (processedTriangles / Math.max(1, source.triangles)),
          label: `Sampling textured geometry · ${processedTriangles.toLocaleString()} / ${source.triangles.toLocaleString()}`,
        });
        await nextFrame();
      }
    }
  }

  if (!accumulated.size) throw new Error('No opaque voxel cells were produced. Try lowering the alpha threshold.');
  const state = new Uint8Array(totalCells);
  const red = new Uint8Array(totalCells);
  const green = new Uint8Array(totalCells);
  const blue = new Uint8Array(totalCells);
  accumulated.forEach((color, index) => {
    state[index] = 1;
    red[index] = Math.round(color.r / color.count);
    green[index] = Math.round(color.g / color.count);
    blue[index] = Math.round(color.b / color.count);
  });

  if (options.fillMode === 'solid') {
    onProgress({ progress: 0.77, label: 'Finding and filling the model interior' });
    await nextFrame();
    solidFill(state, red, green, blue, sx, sy, sz);
  }

  onProgress({ progress: 0.84, label: `Reducing colors to a ${options.paletteSize}-color palette` });
  await nextFrame();
  const rawColors: RGB[] = [];
  for (let i = 0; i < totalCells; i += 1) {
    if (state[i] === 1 || state[i] === 3) rawColors.push({ r: red[i], g: green[i], b: blue[i] });
  }
  const palette = buildPalette(rawColors, options.paletteSize);
  const paletteLookup = new Map<number, number>();
  const voxels = [];
  let colorCursor = 0;
  for (let z = 0; z < sz; z += 1) {
    for (let y = 0; y < sy; y += 1) {
      for (let x = 0; x < sx; x += 1) {
        const cellIndex = x + sx * (y + sy * z);
        if (state[cellIndex] !== 1 && state[cellIndex] !== 3) continue;
        const color = rawColors[colorCursor++];
        const colorKey = (color.r << 16) | (color.g << 8) | color.b;
        let colorIndex = paletteLookup.get(colorKey);
        if (colorIndex === undefined) {
          colorIndex = nearestPaletteIndex(color, palette);
          paletteLookup.set(colorKey, colorIndex);
        }
        const mapped = palette[colorIndex];
        voxels.push({ x, y, z, ...mapped, colorIndex });
      }
    }
  }

  onProgress({ progress: 1, label: 'Voxel model ready' });
  return {
    voxels,
    palette,
    size: { x: sx, y: sy, z: sz },
    voxelSize,
    sourceName: source.name,
  };
}
