import type { RGB, VoxelModel } from '../types';

const encoder = new TextEncoder();

function writeString(view: DataView, offset: number, value: string) {
  new Uint8Array(view.buffer, offset, value.length).set(encoder.encode(value));
}

function chunk(id: string, content: Uint8Array, children = new Uint8Array()): Uint8Array {
  const bytes = new Uint8Array(12 + content.length + children.length);
  const view = new DataView(bytes.buffer);
  writeString(view, 0, id);
  view.setUint32(4, content.length, true);
  view.setUint32(8, children.length, true);
  bytes.set(content, 12);
  bytes.set(children, 12 + content.length);
  return bytes;
}

function makePalette(colors: RGB[]): Uint8Array {
  const content = new Uint8Array(256 * 4);
  for (let i = 0; i < 255; i += 1) {
    const color = colors[i] ?? colors[colors.length - 1] ?? { r: 255, g: 255, b: 255 };
    const offset = i * 4;
    content[offset] = color.r;
    content[offset + 1] = color.g;
    content[offset + 2] = color.b;
    content[offset + 3] = 255;
  }
  return content;
}

export function encodeVox(model: VoxelModel): Uint8Array {
  // MagicaVoxel uses Z-up. The preview/source model is Y-up, so swap Y and Z here.
  const size = new Uint8Array(12);
  const sizeView = new DataView(size.buffer);
  sizeView.setUint32(0, model.size.x, true);
  sizeView.setUint32(4, model.size.z, true);
  sizeView.setUint32(8, model.size.y, true);

  const xyzi = new Uint8Array(4 + model.voxels.length * 4);
  const xyziView = new DataView(xyzi.buffer);
  xyziView.setUint32(0, model.voxels.length, true);
  model.voxels.forEach((voxel, index) => {
    const offset = 4 + index * 4;
    xyzi[offset] = voxel.x;
    xyzi[offset + 1] = voxel.z;
    xyzi[offset + 2] = voxel.y;
    xyzi[offset + 3] = Math.min(255, voxel.colorIndex + 1);
  });

  const childrenParts = [chunk('SIZE', size), chunk('XYZI', xyzi), chunk('RGBA', makePalette(model.palette))];
  const childrenLength = childrenParts.reduce((sum, part) => sum + part.length, 0);
  const children = new Uint8Array(childrenLength);
  let cursor = 0;
  for (const part of childrenParts) {
    children.set(part, cursor);
    cursor += part.length;
  }
  const main = chunk('MAIN', new Uint8Array(), children);
  const output = new Uint8Array(8 + main.length);
  const view = new DataView(output.buffer);
  writeString(view, 0, 'VOX ');
  view.setUint32(4, 150, true);
  output.set(main, 8);
  return output;
}

export function downloadVox(model: VoxelModel) {
  const bytes = encodeVox(model);
  const blob = new Blob([bytes], { type: 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  const baseName = model.sourceName.replace(/\.[^.]+$/, '').replace(/[^a-z0-9_-]+/gi, '-');
  anchor.href = url;
  anchor.download = `${baseName || 'model'}-${model.size.x}x${model.size.y}x${model.size.z}.vox`;
  anchor.click();
  URL.revokeObjectURL(url);
}
