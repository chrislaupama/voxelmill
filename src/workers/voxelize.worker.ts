import { loadGlbBuffer } from '../lib/modelLoader';
import { voxelizeModel } from '../lib/voxelize';
import type { ProgressUpdate, VoxelModel, VoxelizeOptions } from '../types';

interface ConvertRequest {
  type: 'convert';
  buffer: ArrayBuffer;
  name: string;
  bytes: number;
  options: VoxelizeOptions;
}

type Response =
  | { type: 'progress'; update: ProgressUpdate }
  | { type: 'result'; model: VoxelModel }
  | { type: 'error'; message: string };

interface WorkerScope {
  onmessage: ((event: MessageEvent<ConvertRequest>) => void) | null;
  postMessage(message: Response): void;
}

const scope = globalThis as unknown as WorkerScope;

scope.onmessage = async ({ data }) => {
  if (data.type !== 'convert') return;
  try {
    scope.postMessage({ type: 'progress', update: { progress: 0.01, label: 'Opening GLB in background' } });
    const source = await loadGlbBuffer(data.buffer, data.name, data.bytes);
    scope.postMessage({ type: 'progress', update: { progress: 0.03, label: 'Preparing mesh data' } });
    const model = await voxelizeModel(source, data.options, (update) => {
      scope.postMessage({ type: 'progress', update });
    });
    scope.postMessage({ type: 'result', model });
  } catch (error) {
    scope.postMessage({
      type: 'error',
      message: error instanceof Error ? error.message : 'The model could not be converted.',
    });
  }
};
