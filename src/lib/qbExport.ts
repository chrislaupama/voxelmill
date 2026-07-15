import type { VoxelModel } from '../types';
import { buildVoxelIndex, packVoxelCoordinate } from './voxelIndex';

const CODE_FLAG = 2;
const NEXT_SLICE_FLAG = 6;
const encoder = new TextEncoder();

function safeName(value: string) {
  return value.replace(/\.[^.]+$/, '').replace(/[^a-z0-9_-]+/gi, '-').replace(/^-+|-+$/g, '') || 'model';
}

export function encodeQb(model: VoxelModel): Uint8Array {
  const name = encoder.encode(safeName(model.sourceName)).slice(0, 255);
  const values: number[] = [];
  const writeUint32 = (value: number) => values.push(value >>> 0);

  writeUint32(0x00000101); // Qubicle Binary 1.1
  writeUint32(0); // RGBA
  writeUint32(1); // right-handed Z axis
  writeUint32(1); // compressed
  writeUint32(0); // no visibility mask
  writeUint32(1); // one matrix

  const header = new Uint8Array(values.length * 4 + 1 + name.length + 24);
  const headerView = new DataView(header.buffer);
  values.forEach((value, index) => headerView.setUint32(index * 4, value, true));
  let offset = values.length * 4;
  header[offset] = name.length;
  header.set(name, offset + 1);
  offset += 1 + name.length;
  headerView.setUint32(offset, model.size.x, true);
  headerView.setUint32(offset + 4, model.size.y, true);
  headerView.setUint32(offset + 8, model.size.z, true);
  headerView.setInt32(offset + 12, 0, true);
  headerView.setInt32(offset + 16, 0, true);
  headerView.setInt32(offset + 20, 0, true);

  const index = buildVoxelIndex(model.voxels);
  const body: number[] = [];
  const colorAt = (x: number, y: number, z: number) => {
    const voxel = index.get(packVoxelCoordinate({ x, y, z }))?.voxel;
    return voxel ? (voxel.r | (voxel.g << 8) | (voxel.b << 16) | (255 << 24)) >>> 0 : 0;
  };
  for (let z = 0; z < model.size.z; z += 1) {
    let runColor = colorAt(0, 0, z);
    let runLength = 0;
    const flush = () => {
      if (!runLength) return;
      if (runLength === 1 && runColor !== CODE_FLAG && runColor !== NEXT_SLICE_FLAG) body.push(runColor);
      else body.push(CODE_FLAG, runLength, runColor);
    };
    for (let y = 0; y < model.size.y; y += 1) {
      for (let x = 0; x < model.size.x; x += 1) {
        const color = colorAt(x, y, z);
        if (color === runColor) runLength += 1;
        else {
          flush();
          runColor = color;
          runLength = 1;
        }
      }
    }
    flush();
    body.push(NEXT_SLICE_FLAG);
  }
  const bodyBytes = new Uint8Array(body.length * 4);
  const bodyView = new DataView(bodyBytes.buffer);
  body.forEach((value, indexValue) => bodyView.setUint32(indexValue * 4, value, true));
  const output = new Uint8Array(header.length + bodyBytes.length);
  output.set(header);
  output.set(bodyBytes, header.length);
  return output;
}

export function downloadQb(model: VoxelModel) {
  const bytes = encodeQb(model);
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `${safeName(model.sourceName)}-${model.size.x}x${model.size.y}x${model.size.z}.qb`;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
