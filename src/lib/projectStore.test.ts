import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clearAutosave,
  clearRecoveryHistory,
  listRecoverySnapshots,
  loadAutosave,
  loadRecoverySnapshot,
  MAX_RECOVERY_HISTORY_BYTES,
  MAX_RECOVERY_SNAPSHOT_BYTES,
  planRecoveryHistory,
  recoveryFingerprint,
  recoveryProjectKey,
  saveAutosave,
  type StoredRecoverySnapshot,
} from './projectStore';
import type { VoxelMillProject } from './projectFormat';

const project: VoxelMillProject = {
  options: {
    resolution: 8,
    paletteSize: 1,
    fillMode: 'surface',
    alphaThreshold: 0.1,
    samplingQuality: 'draft',
    materialColorMode: 'baseColor',
  },
  model: {
    sourceName: 'offline.glb',
    voxelSize: 1,
    size: { x: 1, y: 1, z: 1 },
    palette: [{ r: 1, g: 2, b: 3 }],
    voxels: [{ x: 0, y: 0, z: 0, colorIndex: 0, r: 1, g: 2, b: 3 }],
  },
};

const bytes = (...values: number[]) => new Uint8Array(values).buffer;

function snapshot(
  id: string,
  sourceName: string,
  savedAt: number,
  content: ArrayBuffer = bytes(savedAt & 0xff),
): StoredRecoverySnapshot {
  return {
    id,
    kind: 'snapshot',
    sourceName,
    projectKey: recoveryProjectKey(sourceName),
    savedAt,
    fingerprint: recoveryFingerprint(content),
    bytes: content,
  };
}

function nextSnapshot(sourceName: string, savedAt: number, content: ArrayBuffer) {
  return {
    sourceName,
    projectKey: recoveryProjectKey(sourceName),
    savedAt,
    fingerprint: recoveryFingerprint(content),
    bytes: content,
  };
}

afterEach(() => vi.unstubAllGlobals());

describe('project recovery storage', () => {
  it('degrades safely when IndexedDB is unavailable', async () => {
    vi.stubGlobal('indexedDB', undefined);
    await expect(saveAutosave(project)).resolves.toBeNull();
    await expect(loadAutosave()).resolves.toBeNull();
    await expect(listRecoverySnapshots()).resolves.toEqual([]);
    await expect(loadRecoverySnapshot('recovery:missing')).resolves.toBeNull();
    await expect(clearRecoveryHistory()).resolves.toBeUndefined();
    await expect(clearAutosave()).resolves.toBeUndefined();
  });

  it('rejects non-snapshot IDs without touching browser storage', async () => {
    const open = vi.fn();
    vi.stubGlobal('indexedDB', { open });
    await expect(loadRecoverySnapshot('autosave')).resolves.toBeNull();
    expect(open).not.toHaveBeenCalled();
  });
});

describe('recovery history planning', () => {
  it('uses conservative browser-friendly byte budgets', () => {
    expect(MAX_RECOVERY_SNAPSHOT_BYTES).toBe(16 * 1024 * 1024);
    expect(MAX_RECOVERY_HISTORY_BYTES).toBe(64 * 1024 * 1024);
  });

  it('normalizes source names into stable per-project buckets', () => {
    expect(recoveryProjectKey('  ROCKET\u212A.GLB  ')).toBe(recoveryProjectKey('rocketk.glb'));
    expect(recoveryProjectKey('')).toBe('source:untitled');
  });

  it('fingerprints content deterministically and includes its length', () => {
    expect(recoveryFingerprint(bytes(1, 2, 3))).toBe(recoveryFingerprint(bytes(1, 2, 3)));
    expect(recoveryFingerprint(bytes(1, 2, 3))).not.toBe(recoveryFingerprint(bytes(1, 2, 3, 0)));
    expect(recoveryFingerprint(bytes(1, 2, 3))).not.toBe(recoveryFingerprint(bytes(1, 2, 4)));
  });

  it('does not add another version when the latest snapshot is byte-identical', () => {
    const content = bytes(4, 5, 6);
    const current = snapshot('recovery:current', 'rocket.glb', 10, content);
    const plan = planRecoveryHistory([current], nextSnapshot('rocket.glb', 20, bytes(4, 5, 6)));

    expect(plan.snapshotToPut).toBeNull();
    expect(plan.deleteIds).toEqual([]);
  });

  it('moves an older repeated version to the front instead of duplicating it', () => {
    const original = snapshot('recovery:original', 'rocket.glb', 10, bytes(1));
    const newer = snapshot('recovery:newer', 'rocket.glb', 20, bytes(2));
    const plan = planRecoveryHistory([original, newer], nextSnapshot('rocket.glb', 30, bytes(1)));

    expect(plan.snapshotToPut).toMatchObject({ id: original.id, savedAt: 30 });
    expect(plan.snapshotToPut?.bytes).toEqual(original.bytes);
    expect(plan.deleteIds).toEqual([]);
  });

  it('uses exact bytes so a fingerprint collision cannot discard a version', () => {
    const prior = snapshot('recovery:prior', 'rocket.glb', 10, bytes(1));
    const colliding = bytes(2);
    const plan = planRecoveryHistory([prior], {
      ...nextSnapshot('rocket.glb', 20, colliding),
      fingerprint: prior.fingerprint,
    });

    expect(plan.snapshotToPut).not.toBeNull();
    expect(plan.snapshotToPut?.id).not.toBe(prior.id);
  });

  it('keeps only the newest configured versions for each project', () => {
    const rocket = Array.from({ length: 12 }, (_, index) => snapshot(`recovery:rocket:${index}`, 'rocket.glb', index));
    const railgun = Array.from({ length: 12 }, (_, index) => snapshot(`recovery:railgun:${index}`, 'railgun.glb', index));
    const plan = planRecoveryHistory(
      [...rocket, ...railgun],
      nextSnapshot('rocket.glb', 20, bytes(250)),
      10,
      50,
    );

    const deleted = new Set(plan.deleteIds);
    const remainingRocket = rocket.filter(({ id }) => !deleted.has(id)).length + (plan.snapshotToPut ? 1 : 0);
    const remainingRailgun = railgun.filter(({ id }) => !deleted.has(id)).length;
    expect(remainingRocket).toBe(10);
    expect(remainingRailgun).toBe(10);
    expect(deleted).toEqual(new Set([
      'recovery:railgun:0',
      'recovery:railgun:1',
      'recovery:rocket:0',
      'recovery:rocket:1',
      'recovery:rocket:2',
    ]));
  });

  it('also enforces an absolute cap across different projects', () => {
    const records = Array.from({ length: 6 }, (_, projectIndex) =>
      Array.from({ length: 10 }, (_, versionIndex) => snapshot(
        `recovery:${projectIndex}:${versionIndex}`,
        `model-${projectIndex}.glb`,
        projectIndex * 10 + versionIndex,
      )),
    ).flat();
    const plan = planRecoveryHistory(records, nextSnapshot('new.glb', 100, bytes(255)), 10, 50);
    const remaining = records.filter(({ id }) => !plan.deleteIds.includes(id)).length + (plan.snapshotToPut ? 1 : 0);

    expect(remaining).toBe(50);
    expect(plan.deleteIds).toHaveLength(11);
    expect(plan.deleteIds).toContain('recovery:0:0');
    expect(plan.deleteIds).toContain('recovery:1:0');
    expect(plan.deleteIds).not.toContain('recovery:5:9');
  });

  it('still applies retention while skipping a consecutive duplicate', () => {
    const content = bytes(9);
    const records = [
      snapshot('recovery:oldest', 'rocket.glb', 1, bytes(1)),
      snapshot('recovery:middle', 'rocket.glb', 2, bytes(2)),
      snapshot('recovery:latest', 'rocket.glb', 3, content),
    ];
    const plan = planRecoveryHistory(records, nextSnapshot('rocket.glb', 4, bytes(9)), 2, 50);

    expect(plan.snapshotToPut).toBeNull();
    expect(plan.deleteIds).toEqual(['recovery:oldest']);
  });

  it('skips a historical copy above the per-snapshot byte limit', () => {
    const plan = planRecoveryHistory(
      [],
      nextSnapshot('large.glb', 10, bytes(1, 2, 3, 4, 5)),
      10,
      50,
      4,
      64,
    );

    // saveAutosave still writes its separate latest-autosave record.
    expect(plan.snapshotToPut).toBeNull();
    expect(plan.deleteIds).toEqual([]);
  });

  it('removes legacy snapshots that exceed the current per-snapshot byte limit', () => {
    const oversized = snapshot('recovery:oversized', 'large.glb', 1, bytes(1, 2, 3, 4, 5));
    const plan = planRecoveryHistory(
      [oversized],
      nextSnapshot('small.glb', 2, bytes(9)),
      10,
      50,
      4,
      64,
    );

    expect(plan.snapshotToPut).not.toBeNull();
    expect(plan.deleteIds).toEqual(['recovery:oversized']);
  });

  it('keeps the newest snapshots that fit within the global byte budget', () => {
    const oldest = snapshot('recovery:oldest', 'a.glb', 1, bytes(1, 1, 1, 1));
    const middle = snapshot('recovery:middle', 'b.glb', 2, bytes(2, 2, 2, 2));
    const plan = planRecoveryHistory(
      [oldest, middle],
      nextSnapshot('c.glb', 3, bytes(3, 3, 3, 3)),
      10,
      50,
      16,
      8,
    );

    expect(plan.snapshotToPut).not.toBeNull();
    expect(plan.deleteIds).toEqual(['recovery:oldest']);
  });

  it('never exceeds the byte budget when no single snapshot can fit', () => {
    const existing = snapshot('recovery:existing', 'a.glb', 1, bytes(1, 2));
    const plan = planRecoveryHistory(
      [existing],
      nextSnapshot('b.glb', 2, bytes(3, 4)),
      10,
      50,
      16,
      0,
    );

    expect(plan.snapshotToPut).not.toBeNull();
    expect(plan.deleteIds).toEqual(expect.arrayContaining(['recovery:existing', plan.snapshotToPut!.id]));
    expect(plan.deleteIds).toHaveLength(2);
  });
});
