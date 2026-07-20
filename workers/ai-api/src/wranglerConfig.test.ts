import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const configPath = new URL('../wrangler.jsonc', import.meta.url);

function record(value: unknown) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Expected the Wrangler configuration value to be an object.');
  }
  return value as Record<string, unknown>;
}

describe('AI Worker production configuration', () => {
  it('ships paid inference disabled and persists no logs or traces', () => {
    const config = record(JSON.parse(readFileSync(configPath, 'utf8')) as unknown);
    const vars = record(config.vars);
    const observability = record(config.observability);
    const logs = record(observability.logs);
    const traces = record(observability.traces);

    expect(vars.AI_PALETTE_ENABLED).toBe('false');
    expect(observability.enabled).toBe(false);
    expect(logs.enabled).toBe(false);
    expect(logs.invocation_logs).toBe(false);
    expect(logs.persist).toBe(false);
    expect(traces.enabled).toBe(false);
    expect(traces.persist).toBe(false);
  });

  it('does not commit the caller-key secret as a plain environment variable', () => {
    const config = record(JSON.parse(readFileSync(configPath, 'utf8')) as unknown);
    expect(record(config.vars).AI_RATE_LIMIT_HASH_KEY).toBeUndefined();
  });
});
