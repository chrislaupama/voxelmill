const DAILY_ALLOWANCE_PATH = '/reserve';
const DAILY_ALLOWANCE_TABLE = 'ai_daily_inference_allowance';
const MAX_CONFIGURED_DAILY_LIMIT = 10_000;

type SqlValue = ArrayBuffer | string | number | null;

export interface SqlCursor<Row extends Record<string, SqlValue>> {
  toArray(): Row[];
}

export interface SqlStorage {
  exec<Row extends Record<string, SqlValue>>(
    query: string,
    ...bindings: SqlValue[]
  ): SqlCursor<Row>;
}

interface DurableObjectContext {
  storage: { sql: SqlStorage };
}

export interface DailyAllowanceDecision {
  allowed: boolean;
  used: number;
  limit: number;
  utcDay: string;
}

function isUtcDay(value: string) {
  return /^\d{4}-\d{2}-\d{2}$/u.test(value);
}

function isDailyLimit(value: number) {
  return Number.isInteger(value) && value >= 0 && value <= MAX_CONFIGURED_DAILY_LIMIT;
}

/**
 * Reserves one inference attempt using a single atomic SQLite statement.
 * Keeping this synchronous is important: no other Durable Object request can
 * interleave between the capacity check and increment.
 */
export function reserveDailyInference(
  sql: SqlStorage,
  utcDay: string,
  limit: number,
): DailyAllowanceDecision {
  if (!isUtcDay(utcDay) || !isDailyLimit(limit)) throw new Error('INVALID_ALLOWANCE_CONFIGURATION');

  sql.exec(`DELETE FROM ${DAILY_ALLOWANCE_TABLE} WHERE utc_day <> ?`, utcDay);
  if (limit === 0) return { allowed: false, used: 0, limit, utcDay };

  const rows = sql.exec<{ used: number }>(
    `INSERT INTO ${DAILY_ALLOWANCE_TABLE} (utc_day, used)
     VALUES (?, 1)
     ON CONFLICT(utc_day) DO UPDATE SET used = used + 1
     WHERE used < ?
     RETURNING used`,
    utcDay,
    limit,
  ).toArray();

  if (rows.length === 1) {
    return { allowed: true, used: Number(rows[0].used), limit, utcDay };
  }

  const current = sql.exec<{ used: number }>(
    `SELECT used FROM ${DAILY_ALLOWANCE_TABLE} WHERE utc_day = ?`,
    utcDay,
  ).toArray()[0];
  return { allowed: false, used: Number(current?.used ?? limit), limit, utcDay };
}

/**
 * A fetch-based Durable Object remains compatible with both existing Workers
 * and the current declarative export configuration without adding runtime SDK
 * dependencies to this small Worker package.
 */
export class AiDailyInferenceAllowance {
  private readonly sql: SqlStorage;

  constructor(ctx: DurableObjectContext) {
    this.sql = ctx.storage.sql;
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS ${DAILY_ALLOWANCE_TABLE} (
        utc_day TEXT PRIMARY KEY,
        used INTEGER NOT NULL CHECK (used >= 0)
      )`,
    );
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method !== 'POST' || url.pathname !== DAILY_ALLOWANCE_PATH) {
      return Response.json({ error: 'NOT_FOUND' }, { status: 404 });
    }

    try {
      const body = await request.json() as { limit?: unknown };
      const limit = typeof body.limit === 'number' ? body.limit : Number.NaN;
      const utcDay = new Date().toISOString().slice(0, 10);
      return Response.json(reserveDailyInference(this.sql, utcDay, limit));
    } catch {
      return Response.json({ error: 'INVALID_REQUEST' }, { status: 400 });
    }
  }
}
