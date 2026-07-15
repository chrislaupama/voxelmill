import type { ProgressUpdate, VoxelModel, VoxelizeOptions } from '../types';

interface WorkerProgressMessage {
  type: 'progress';
  update: ProgressUpdate;
}

interface WorkerResultMessage {
  type: 'result';
  model: VoxelModel;
}

interface WorkerErrorMessage {
  type: 'error';
  message: string;
}

type WorkerResponse = WorkerProgressMessage | WorkerResultMessage | WorkerErrorMessage;

export class ConversionCancelledError extends Error {
  constructor() {
    super('Conversion cancelled.');
    this.name = 'ConversionCancelledError';
  }
}

export function isConversionCancelled(error: unknown): error is ConversionCancelledError {
  return error instanceof ConversionCancelledError;
}

export function monotonicProgress(previous: number, next: number): number {
  return Math.max(previous, Math.min(1, Math.max(0, next)));
}

export function voxelizeGlbInWorker(
  file: File,
  options: VoxelizeOptions,
  onProgress: (update: ProgressUpdate) => void,
  signal?: AbortSignal,
): Promise<VoxelModel> {
  if (signal?.aborted) return Promise.reject(new ConversionCancelledError());

  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('../workers/voxelize.worker.ts', import.meta.url), { type: 'module' });
    let settled = false;
    let lastProgress = 0;

    const cleanup = () => {
      worker.terminate();
      signal?.removeEventListener('abort', cancel);
    };
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      action();
    };
    const cancel = () => finish(() => reject(new ConversionCancelledError()));

    signal?.addEventListener('abort', cancel, { once: true });
    worker.onerror = (event) => finish(() => reject(new Error(event.message || 'The conversion worker stopped unexpectedly.')));
    worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const message = event.data;
      if (message.type === 'progress') {
        const progress = monotonicProgress(lastProgress, message.update.progress);
        lastProgress = progress;
        onProgress({ ...message.update, progress });
      } else if (message.type === 'result') {
        finish(() => resolve(message.model));
      } else {
        finish(() => reject(new Error(message.message)));
      }
    };

    file.arrayBuffer().then((buffer) => {
      if (settled) return;
      worker.postMessage({ type: 'convert', buffer, name: file.name, bytes: file.size, options }, [buffer]);
    }).catch((error: unknown) => {
      finish(() => reject(error instanceof Error ? error : new Error('The GLB file could not be read.')));
    });
  });
}
