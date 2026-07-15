import { decodeVoxelMillProject, encodeVoxelMillProject, type VoxelMillProject } from './projectFormat';

const DATABASE_NAME = 'voxelmill';
const DATABASE_VERSION = 1;
const STORE_NAME = 'projects';
const AUTOSAVE_KEY = 'autosave';

interface AutosaveRecord {
  id: string;
  savedAt: number;
  bytes: ArrayBuffer;
}

export interface RecoveredProject {
  project: VoxelMillProject;
  savedAt: number;
}

const requestResult = <T>(request: IDBRequest<T>) => new Promise<T>((resolve, reject) => {
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error ?? new Error('Browser storage request failed.'));
});

function openDatabase(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) request.result.createObjectStore(STORE_NAME, { keyPath: 'id' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('VoxelMill could not open local recovery storage.'));
  });
}

export async function saveAutosave(project: VoxelMillProject): Promise<number | null> {
  const database = await openDatabase();
  if (!database) return null;
  const savedAt = Date.now();
  const transaction = database.transaction(STORE_NAME, 'readwrite');
  await requestResult(transaction.objectStore(STORE_NAME).put({
    id: AUTOSAVE_KEY,
    savedAt,
    bytes: encodeVoxelMillProject(project),
  } satisfies AutosaveRecord));
  database.close();
  return savedAt;
}

export async function loadAutosave(): Promise<RecoveredProject | null> {
  const database = await openDatabase();
  if (!database) return null;
  const transaction = database.transaction(STORE_NAME, 'readonly');
  const record = await requestResult(transaction.objectStore(STORE_NAME).get(AUTOSAVE_KEY)) as AutosaveRecord | undefined;
  database.close();
  return record ? { project: decodeVoxelMillProject(record.bytes), savedAt: record.savedAt } : null;
}

export async function clearAutosave(): Promise<void> {
  const database = await openDatabase();
  if (!database) return;
  const transaction = database.transaction(STORE_NAME, 'readwrite');
  await requestResult(transaction.objectStore(STORE_NAME).delete(AUTOSAVE_KEY));
  database.close();
}
