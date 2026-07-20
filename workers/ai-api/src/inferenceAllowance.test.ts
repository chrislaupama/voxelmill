import { describe, expect, it, vi } from 'vitest';
import {
  AiDailyInferenceAllowance,
  reserveDailyInference,
  type SqlCursor,
  type SqlStorage,
} from './inferenceAllowance';

type SqlValue = ArrayBuffer | string | number | null;

class FakeSqlStorage implements SqlStorage {
  readonly execSpy = vi.fn();
  private readonly counts = new Map<string, number>();

  exec<Row extends Record<string, SqlValue>>(query: string, ...bindings: SqlValue[]): SqlCursor<Row> {
    this.execSpy(query, ...bindings);
    const normalized = query.replace(/\s+/gu, ' ').trim();
    let rows: Record<string, SqlValue>[] = [];

    if (normalized.startsWith('DELETE FROM')) {
      const currentDay = String(bindings[0]);
      for (const day of this.counts.keys()) if (day !== currentDay) this.counts.delete(day);
    } else if (normalized.startsWith('INSERT INTO')) {
      const day = String(bindings[0]);
      const limit = Number(bindings[1]);
      const current = this.counts.get(day) ?? 0;
      if (current < limit) {
        const used = current + 1;
        this.counts.set(day, used);
        rows = [{ used }];
      }
    } else if (normalized.startsWith('SELECT used')) {
      const used = this.counts.get(String(bindings[0]));
      if (used !== undefined) rows = [{ used }];
    }

    return { toArray: () => rows as Row[] };
  }
}

describe('AI daily inference allowance', () => {
  it('atomically allows only the configured number of inference attempts', () => {
    const sql = new FakeSqlStorage();
    expect(reserveDailyInference(sql, '2026-07-20', 2)).toMatchObject({ allowed: true, used: 1 });
    expect(reserveDailyInference(sql, '2026-07-20', 2)).toMatchObject({ allowed: true, used: 2 });
    expect(reserveDailyInference(sql, '2026-07-20', 2)).toMatchObject({ allowed: false, used: 2 });
    const atomicStatement = sql.execSpy.mock.calls.find(([query]) => String(query).includes('ON CONFLICT'))?.[0];
    expect(atomicStatement).toContain('WHERE used < ?');
    expect(atomicStatement).toContain('RETURNING used');
  });

  it('resets at a UTC-day boundary and discards the previous counter', () => {
    const sql = new FakeSqlStorage();
    expect(reserveDailyInference(sql, '2026-07-20', 1).allowed).toBe(true);
    expect(reserveDailyInference(sql, '2026-07-20', 1).allowed).toBe(false);
    expect(reserveDailyInference(sql, '2026-07-21', 1)).toMatchObject({ allowed: true, used: 1, utcDay: '2026-07-21' });
    expect(reserveDailyInference(sql, '2026-07-20', 1)).toMatchObject({ allowed: true, used: 1 });
  });

  it('treats a zero limit as a hard kill and rejects invalid configuration', () => {
    const sql = new FakeSqlStorage();
    expect(reserveDailyInference(sql, '2026-07-20', 0)).toEqual({
      allowed: false,
      used: 0,
      limit: 0,
      utcDay: '2026-07-20',
    });
    expect(() => reserveDailyInference(sql, 'not-a-day', 1)).toThrow('INVALID_ALLOWANCE_CONFIGURATION');
    expect(() => reserveDailyInference(sql, '2026-07-20', 10_001)).toThrow('INVALID_ALLOWANCE_CONFIGURATION');
  });

  it('exposes only the internal reservation endpoint', async () => {
    const sql = new FakeSqlStorage();
    const allowance = new AiDailyInferenceAllowance({ storage: { sql } });
    const missing = await allowance.fetch(new Request('https://allowance.internal/other'));
    expect(missing.status).toBe(404);
    const malformed = await allowance.fetch(new Request('https://allowance.internal/reserve', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ limit: 'unlimited' }),
    }));
    expect(malformed.status).toBe(400);
  });
});
