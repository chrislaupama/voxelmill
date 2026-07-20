import { decodeVoxelMillProject, encodeVoxelMillProject, type VoxelMillProject } from './projectFormat';

const DATABASE_NAME = 'voxelmill';
const DATABASE_VERSION = 2;
const STORE_NAME = 'projects';
const AUTOSAVE_KEY = 'autosave';
const SNAPSHOT_ID_PREFIX = 'recovery:';

export const MAX_RECOVERY_SNAPSHOTS_PER_PROJECT = 10;
export const MAX_RECOVERY_SNAPSHOTS_TOTAL = 50;
/** Large projects retain their latest autosave without duplicating it into history. */
export const MAX_RECOVERY_SNAPSHOT_BYTES = 16 * 1024 * 1024;
/** Historical snapshots share this bounded storage budget; the latest autosave is separate. */
export const MAX_RECOVERY_HISTORY_BYTES = 64 * 1024 * 1024;

interface AutosaveRecord {
  id: typeof AUTOSAVE_KEY;
  kind: 'autosave';
  sourceName: string;
  projectKey: string;
  savedAt: number;
  fingerprint: string;
  bytes: ArrayBuffer;
}

/** @internal Exported so the retention policy can be tested without emulating IndexedDB. */
export interface StoredRecoverySnapshot {
  id: string;
  kind: 'snapshot';
  sourceName: string;
  projectKey: string;
  savedAt: number;
  fingerprint: string;
  bytes: ArrayBuffer;
}

export interface RecoveredProject {
  project: VoxelMillProject;
  savedAt: number;
}

export interface RecoverySnapshotSummary {
  id: string;
  sourceName: string;
  savedAt: number;
  byteLength: number;
}

/** @internal Exported so the retention policy can be tested without emulating IndexedDB. */
export interface RecoveryHistoryPlan {
  snapshotToPut: StoredRecoverySnapshot | null;
  deleteIds: string[];
}

const requestResult = <T>(request: IDBRequest<T>) => new Promise<T>((resolve, reject) => {
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error ?? new Error('Browser storage request failed.'));
});

const transactionResult = (transaction: IDBTransaction) => {
  const result = new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new Error('Browser storage transaction was aborted.'));
    transaction.onerror = () => reject(transaction.error ?? new Error('Browser storage transaction failed.'));
  });
  // A request can fail before its caller reaches `await result`; attach a handler
  // immediately while still returning the original rejecting promise.
  void result.catch(() => undefined);
  return result;
};

function openDatabase(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    let settled = false;
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) request.result.createObjectStore(STORE_NAME, { keyPath: 'id' });
    };
    request.onsuccess = () => {
      if (settled) request.result.close();
      else {
        settled = true;
        resolve(request.result);
      }
    };
    request.onerror = () => {
      if (!settled) {
        settled = true;
        reject(request.error ?? new Error('VoxelMill could not open local recovery storage.'));
      }
    };
    request.onblocked = () => {
      if (!settled) {
        settled = true;
        reject(new Error('VoxelMill local recovery storage is blocked by another tab.'));
      }
    };
  });
}

function asArrayBuffer(value: unknown): ArrayBuffer | null {
  if (value instanceof ArrayBuffer) return value;
  if (ArrayBuffer.isView(value)) {
    return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer;
  }
  return null;
}

function isFiniteTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/** A stable recovery bucket for edits to the same imported source/project. */
export function recoveryProjectKey(sourceName: string): string {
  const normalized = sourceName.normalize('NFKC').trim().toLowerCase();
  return `source:${normalized || 'untitled'}`;
}

/** Fast content key; exact byte comparison below makes hash collisions harmless. */
export function recoveryFingerprint(bytes: ArrayBuffer): string {
  let hash = 0x811c9dc5;
  for (const byte of new Uint8Array(bytes)) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193);
  }
  return `${bytes.byteLength}:${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

function equalBytes(left: ArrayBuffer, right: ArrayBuffer): boolean {
  if (left.byteLength !== right.byteLength) return false;
  const leftView = new Uint8Array(left);
  const rightView = new Uint8Array(right);
  for (let index = 0; index < leftView.length; index += 1) {
    if (leftView[index] !== rightView[index]) return false;
  }
  return true;
}

function compareNewest(left: StoredRecoverySnapshot, right: StoredRecoverySnapshot): number {
  return right.savedAt - left.savedAt || right.id.localeCompare(left.id);
}

function uniqueSnapshotId(records: readonly StoredRecoverySnapshot[], savedAt: number, fingerprint: string): string {
  const prefix = `${SNAPSHOT_ID_PREFIX}${savedAt}:${fingerprint}:`;
  const ids = new Set(records.map(({ id }) => id));
  let suffix = 0;
  while (ids.has(`${prefix}${suffix}`)) suffix += 1;
  return `${prefix}${suffix}`;
}

/**
 * Plans one atomic history update. Identical consecutive saves are ignored; if
 * content returns to an older version, that version is moved to the front rather
 * than duplicated. Retention is capped by count per project, total count, and
 * total bytes. Content above the per-snapshot byte limit is not added to history.
 * The separately stored latest autosave is intentionally outside these limits.
 *
 * @internal Exported so this policy can be tested without an IndexedDB shim.
 */
export function planRecoveryHistory(
  records: readonly StoredRecoverySnapshot[],
  next: Omit<StoredRecoverySnapshot, 'id' | 'kind'>,
  perProjectLimit = MAX_RECOVERY_SNAPSHOTS_PER_PROJECT,
  totalLimit = MAX_RECOVERY_SNAPSHOTS_TOTAL,
  perSnapshotByteLimit = MAX_RECOVERY_SNAPSHOT_BYTES,
  totalByteLimit = MAX_RECOVERY_HISTORY_BYTES,
): RecoveryHistoryPlan {
  const safePerProjectLimit = Number.isFinite(perProjectLimit) ? Math.max(1, Math.floor(perProjectLimit)) : MAX_RECOVERY_SNAPSHOTS_PER_PROJECT;
  const safeTotalLimit = Number.isFinite(totalLimit) ? Math.max(1, Math.floor(totalLimit)) : MAX_RECOVERY_SNAPSHOTS_TOTAL;
  const safePerSnapshotByteLimit = Number.isFinite(perSnapshotByteLimit)
    ? Math.max(0, Math.floor(perSnapshotByteLimit))
    : MAX_RECOVERY_SNAPSHOT_BYTES;
  const safeTotalByteLimit = Number.isFinite(totalByteLimit)
    ? Math.max(0, Math.floor(totalByteLimit))
    : MAX_RECOVERY_HISTORY_BYTES;
  const projectRecords = records.filter(({ projectKey }) => projectKey === next.projectKey).sort(compareNewest);
  const matching = projectRecords.find((record) => record.fingerprint === next.fingerprint && equalBytes(record.bytes, next.bytes));
  const latest = projectRecords[0];
  let snapshotToPut: StoredRecoverySnapshot | null = null;

  if (next.bytes.byteLength > safePerSnapshotByteLimit) {
    snapshotToPut = null;
  } else if (!matching) {
    snapshotToPut = {
      ...next,
      id: uniqueSnapshotId(records, next.savedAt, next.fingerprint),
      kind: 'snapshot',
    };
  } else if (matching.id !== latest?.id) {
    snapshotToPut = { ...matching, sourceName: next.sourceName, savedAt: next.savedAt };
  }

  const candidates = snapshotToPut
    ? [...records.filter(({ id }) => id !== snapshotToPut.id), snapshotToPut]
    : [...records];
  const deleteIds = new Set(candidates
    .filter(({ bytes }) => bytes.byteLength > safePerSnapshotByteLimit)
    .map(({ id }) => id));
  const groups = new Map<string, StoredRecoverySnapshot[]>();
  for (const record of candidates) {
    const group = groups.get(record.projectKey) ?? [];
    group.push(record);
    groups.set(record.projectKey, group);
  }
  for (const group of groups.values()) {
    group.sort(compareNewest).slice(safePerProjectLimit).forEach(({ id }) => deleteIds.add(id));
  }
  candidates
    .filter(({ id }) => !deleteIds.has(id))
    .sort(compareNewest)
    .slice(safeTotalLimit)
    .forEach(({ id }) => deleteIds.add(id));
  let retainedBytes = 0;
  for (const record of candidates.filter(({ id }) => !deleteIds.has(id)).sort(compareNewest)) {
    if (retainedBytes + record.bytes.byteLength > safeTotalByteLimit) deleteIds.add(record.id);
    else retainedBytes += record.bytes.byteLength;
  }

  return { snapshotToPut, deleteIds: [...deleteIds].sort() };
}

function parseSnapshotRecord(value: unknown): StoredRecoverySnapshot | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Partial<StoredRecoverySnapshot>;
  const bytes = asArrayBuffer(record.bytes);
  if (record.kind !== 'snapshot'
    || typeof record.id !== 'string' || !record.id.startsWith(SNAPSHOT_ID_PREFIX)
    || typeof record.sourceName !== 'string' || !record.sourceName
    || typeof record.projectKey !== 'string' || record.projectKey !== recoveryProjectKey(record.sourceName)
    || !isFiniteTimestamp(record.savedAt)
    || typeof record.fingerprint !== 'string'
    || !bytes) return null;
  return { ...record, bytes } as StoredRecoverySnapshot;
}

function parseAutosaveRecord(value: unknown): { bytes: ArrayBuffer; savedAt: number } | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Partial<AutosaveRecord> & { bytes?: unknown };
  const bytes = asArrayBuffer(record.bytes);
  // Records written by database version 1 had no discriminator or metadata.
  if (record.id !== AUTOSAVE_KEY || !isFiniteTimestamp(record.savedAt) || !bytes) return null;
  return { bytes, savedAt: record.savedAt };
}

function malformedSnapshotIds(values: readonly unknown[]): string[] {
  return values.flatMap((value) => {
    if (!value || typeof value !== 'object') return [];
    const id = (value as { id?: unknown }).id;
    return typeof id === 'string' && id.startsWith(SNAPSHOT_ID_PREFIX) && !parseSnapshotRecord(value) ? [id] : [];
  });
}

export async function saveAutosave(project: VoxelMillProject): Promise<number | null> {
  let database: IDBDatabase | null = null;
  try {
    database = await openDatabase();
    if (!database) return null;
    const savedAt = Date.now();
    const bytes = encodeVoxelMillProject(project);
    const sourceName = project.model.sourceName;
    const projectKey = recoveryProjectKey(sourceName);
    const fingerprint = recoveryFingerprint(bytes);
    const transaction = database.transaction(STORE_NAME, 'readwrite');
    const completed = transactionResult(transaction);
    const store = transaction.objectStore(STORE_NAME);
    const values = await requestResult(store.getAll()) as unknown[];
    const snapshots = values.map(parseSnapshotRecord).filter((record): record is StoredRecoverySnapshot => record !== null);
    const plan = planRecoveryHistory(snapshots, { sourceName, projectKey, savedAt, fingerprint, bytes });

    store.put({ id: AUTOSAVE_KEY, kind: 'autosave', sourceName, projectKey, savedAt, fingerprint, bytes } satisfies AutosaveRecord);
    if (plan.snapshotToPut) store.put(plan.snapshotToPut);
    for (const id of new Set([...plan.deleteIds, ...malformedSnapshotIds(values)])) store.delete(id);
    await completed;
    return savedAt;
  } catch {
    return null;
  } finally {
    database?.close();
  }
}

export async function loadAutosave(): Promise<RecoveredProject | null> {
  let database: IDBDatabase | null = null;
  try {
    database = await openDatabase();
    if (!database) return null;
    const transaction = database.transaction(STORE_NAME, 'readonly');
    const completed = transactionResult(transaction);
    const value = await requestResult(transaction.objectStore(STORE_NAME).get(AUTOSAVE_KEY));
    await completed;
    const record = parseAutosaveRecord(value);
    if (!record) return null;
    return { project: decodeVoxelMillProject(record.bytes), savedAt: record.savedAt };
  } catch {
    return null;
  } finally {
    database?.close();
  }
}

export async function listRecoverySnapshots(sourceName?: string): Promise<RecoverySnapshotSummary[]> {
  let database: IDBDatabase | null = null;
  try {
    database = await openDatabase();
    if (!database) return [];
    const transaction = database.transaction(STORE_NAME, 'readonly');
    const completed = transactionResult(transaction);
    const values = await requestResult(transaction.objectStore(STORE_NAME).getAll()) as unknown[];
    await completed;
    const requestedKey = sourceName === undefined ? null : recoveryProjectKey(sourceName);
    const summaries: RecoverySnapshotSummary[] = [];
    for (const value of values) {
      const record = parseSnapshotRecord(value);
      if (!record || (requestedKey !== null && record.projectKey !== requestedKey)) continue;
      try {
        const decoded = decodeVoxelMillProject(record.bytes);
        if (recoveryProjectKey(decoded.model.sourceName) !== record.projectKey
          || recoveryFingerprint(record.bytes) !== record.fingerprint) continue;
        summaries.push({ id: record.id, sourceName: record.sourceName, savedAt: record.savedAt, byteLength: record.bytes.byteLength });
      } catch {
        // A damaged snapshot should not hide the remaining recovery history.
      }
    }
    return summaries.sort((left, right) => right.savedAt - left.savedAt || right.id.localeCompare(left.id));
  } catch {
    return [];
  } finally {
    database?.close();
  }
}

export async function loadRecoverySnapshot(id: string): Promise<RecoveredProject | null> {
  if (!id.startsWith(SNAPSHOT_ID_PREFIX)) return null;
  let database: IDBDatabase | null = null;
  try {
    database = await openDatabase();
    if (!database) return null;
    const transaction = database.transaction(STORE_NAME, 'readonly');
    const completed = transactionResult(transaction);
    const value = await requestResult(transaction.objectStore(STORE_NAME).get(id));
    await completed;
    const record = parseSnapshotRecord(value);
    if (!record || recoveryFingerprint(record.bytes) !== record.fingerprint) return null;
    const project = decodeVoxelMillProject(record.bytes);
    return recoveryProjectKey(project.model.sourceName) === record.projectKey ? { project, savedAt: record.savedAt } : null;
  } catch {
    return null;
  } finally {
    database?.close();
  }
}

export async function clearRecoveryHistory(sourceName?: string): Promise<void> {
  let database: IDBDatabase | null = null;
  try {
    database = await openDatabase();
    if (!database) return;
    const transaction = database.transaction(STORE_NAME, 'readwrite');
    const completed = transactionResult(transaction);
    const store = transaction.objectStore(STORE_NAME);
    const values = await requestResult(store.getAll()) as unknown[];
    const requestedKey = sourceName === undefined ? null : recoveryProjectKey(sourceName);
    for (const value of values) {
      const record = parseSnapshotRecord(value);
      if (record && (requestedKey === null || record.projectKey === requestedKey)) store.delete(record.id);
      else if (requestedKey === null && value && typeof value === 'object') {
        const id = (value as { id?: unknown }).id;
        if (typeof id === 'string' && id.startsWith(SNAPSHOT_ID_PREFIX)) store.delete(id);
      }
    }
    await completed;
  } catch {
    // Recovery storage is best-effort; callers should not lose app functionality.
  } finally {
    database?.close();
  }
}

export async function clearAutosave(): Promise<void> {
  let database: IDBDatabase | null = null;
  try {
    database = await openDatabase();
    if (!database) return;
    const transaction = database.transaction(STORE_NAME, 'readwrite');
    const completed = transactionResult(transaction);
    transaction.objectStore(STORE_NAME).delete(AUTOSAVE_KEY);
    await completed;
  } catch {
    // Recovery storage is best-effort; callers should not lose app functionality.
  } finally {
    database?.close();
  }
}
