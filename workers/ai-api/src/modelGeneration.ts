export type GenerationKind = 'text-to-3d' | 'image-to-3d';
export type GenerationState = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';

export interface ModelGenerationInput {
  kind: GenerationKind;
  prompt?: string;
  imageUrl?: string;
  targetFormat: 'glb';
}

export interface ProviderJob {
  providerJobId: string;
  state: GenerationState;
  progress: number;
  artifactUrl?: string;
  errorCode?: string;
}

export interface ModelGenerationProvider {
  readonly id: string;
  create(input: ModelGenerationInput): Promise<ProviderJob>;
  get(providerJobId: string, kind: GenerationKind): Promise<ProviderJob>;
  cancel(providerJobId: string, kind: GenerationKind): Promise<void>;
}

export interface ModelGenerationJobRecord {
  id: string;
  provider: string;
  providerJobId: string;
  kind: GenerationKind;
  state: GenerationState;
  progress: number;
  artifactKey?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ModelGenerationJobRepository {
  create(record: ModelGenerationJobRecord): Promise<void>;
  get(id: string): Promise<ModelGenerationJobRecord | null>;
  update(record: ModelGenerationJobRecord): Promise<void>;
}

export interface ModelArtifactStore {
  persistFromUrl(jobId: string, url: string): Promise<{ key: string }>;
  delete(key: string): Promise<void>;
}

export const modelGenerationCapabilities = {
  version: 1,
  available: false,
  modes: ['text-to-3d', 'image-to-3d'] as GenerationKind[],
  outputFormat: 'glb' as const,
  provider: null,
  message: 'The secure job contract is ready. A generation provider and private artifact storage still need to be configured.',
};
