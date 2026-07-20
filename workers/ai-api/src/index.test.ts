import { describe, expect, it, vi } from 'vitest';
import type { Env } from './index';
import { handleRequest } from './index';

const paletteRequest = {
  version: 1,
  prompt: 'icy industrial sci-fi',
  targetColorCount: 3,
  palette: [
    { hex: '#101010', count: 20, locked: true },
    { hex: '#808080', count: 10, locked: false },
    { hex: '#f0f0f0', count: 2, locked: false },
  ],
};

function environment(response: unknown = {
  response: {
    suggestions: [0, 1, 2].map((index) => ({
      name: `Direction ${index + 1}`,
      description: 'A deliberate cool tonal ramp.',
      colors: [
        ['#061525', '#3977a8', '#d8f4ff'],
        ['#24102f', '#8f4ca8', '#f2ccff'],
        ['#172207', '#7f9830', '#efffb8'],
      ][index],
    })),
  },
}) {
  const allowanceFetch = vi.fn().mockImplementation(() => Promise.resolve(Response.json({
    allowed: true,
    used: 1,
    limit: 100,
    utcDay: '2026-07-20',
  })));
  return {
    AI: { run: vi.fn().mockResolvedValue(response) },
    CALLER_RATE_LIMITER: { limit: vi.fn().mockResolvedValue({ success: true }) },
    EDGE_RATE_LIMITER: { limit: vi.fn().mockResolvedValue({ success: true }) },
    AI_DAILY_ALLOWANCE: {
      idFromName: vi.fn().mockReturnValue('global-allowance-id'),
      get: vi.fn().mockReturnValue({ fetch: allowanceFetch }),
    },
    AI_PALETTE_ENABLED: 'true',
    AI_PALETTE_MODEL: '@cf/meta/llama-3.1-8b-instruct-fast',
    AI_DAILY_REQUEST_LIMIT: '100',
    AI_REQUEST_DEADLINE_MS: '20000',
    AI_RATE_LIMIT_HASH_KEY: 'test-only-rate-limit-key-with-32-characters',
  } satisfies Env;
}

function request(body: unknown = paletteRequest, headers: Record<string, string> = {}) {
  return new Request('https://api.voxelmill.com/v1/palette', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: 'https://voxelmill.com',
      'cf-connecting-ip': '203.0.113.10',
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

describe('VoxelMill AI Worker', () => {
  it('returns three validated palettes, reinjects locked colors, and reserves the global allowance first', async () => {
    const env = environment();
    const paletteHttpRequest = request();
    const response = await handleRequest(paletteHttpRequest, env);
    expect(response.status).toBe(200);
    expect(response.headers.get('access-control-allow-origin')).toBe('https://voxelmill.com');
    const body = await response.json() as { suggestions: { colors: string[] }[] };
    expect(body.suggestions).toHaveLength(3);
    expect(body.suggestions.every((suggestion) => suggestion.colors[0] === '#101010')).toBe(true);
    expect(env.AI.run).toHaveBeenCalledOnce();
    expect(env.AI.run).toHaveBeenCalledWith('@cf/meta/llama-3.1-8b-instruct-fast', expect.any(Object), { signal: expect.any(AbortSignal) });
    const allowance = env.AI_DAILY_ALLOWANCE.get('global-allowance-id');
    expect(allowance.fetch).toHaveBeenCalledOnce();
    expect(allowance.fetch.mock.invocationCallOrder[0]).toBeLessThan(env.AI.run.mock.invocationCallOrder[0]);
    const allowanceRequest = allowance.fetch.mock.calls[0][0] as Request;
    expect(await allowanceRequest.clone().json()).toEqual({ limit: 100 });
    expect(allowanceRequest.headers.get('content-type')).toBe('application/json');
    expect(allowanceRequest.headers.get('cf-connecting-ip')).toBeNull();
    expect(allowanceRequest.headers.get('x-voxelmill-client')).toBeNull();
  });

  it('rejects an oversized streamed body without relying on Content-Length', async () => {
    const env = environment();
    const oversized = request({ ...paletteRequest, prompt: 'x'.repeat(33 * 1024) });
    expect(oversized.headers.has('content-length')).toBe(false);
    const response = await handleRequest(oversized, env);
    expect(response.status).toBe(413);
    expect(env.AI.run).not.toHaveBeenCalled();
  });

  it('requires at least one target slot to remain unlocked', async () => {
    const env = environment();
    const response = await handleRequest(request({
      ...paletteRequest,
      targetColorCount: 2,
      palette: [
        { hex: '#101010', count: 20, locked: true },
        { hex: '#f0f0f0', count: 2, locked: true },
      ],
    }), env);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { message: expect.stringContaining('at least one') } });
    expect(env.AI.run).not.toHaveBeenCalled();
  });

  it('rejects candidate directions that normalize to the same palette', async () => {
    const env = environment({
      response: {
        suggestions: [0, 1, 2].map((index) => ({
          name: `Direction ${index + 1}`,
          description: 'The same colors in a different order are still the same palette.',
          colors: index === 0
            ? ['#101010', '#061525', '#3977a8']
            : index === 1
              ? ['#3977a8', '#101010', '#061525']
              : ['#101010', '#7f9830', '#efffb8'],
        })),
      },
    });
    const response = await handleRequest(request(), env);
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ error: { code: 'AI_SCHEMA_MISMATCH' } });
  });

  it('rejects malformed input before calling Workers AI', async () => {
    const env = environment();
    const response = await handleRequest(request({ ...paletteRequest, prompt: '' }), env);
    expect(response.status).toBe(400);
    expect(env.AI.run).not.toHaveBeenCalled();
    expect(JSON.stringify(await response.json())).not.toContain('icy industrial');
  });

  it('enforces both rate limit bindings', async () => {
    const env = environment();
    env.EDGE_RATE_LIMITER.limit = vi.fn().mockResolvedValue({ success: false });
    const response = await handleRequest(request(), env);
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('60');
    expect(env.AI.run).not.toHaveBeenCalled();
  });

  it('requires an exact trusted origin for generation and keeps health public', async () => {
    const env = environment();
    const rejected = await handleRequest(request(paletteRequest, { origin: 'https://attacker.example' }), env);
    expect(rejected.status).toBe(403);
    expect(await rejected.json()).toMatchObject({ error: { code: 'ORIGIN_NOT_ALLOWED' } });
    const preview = await handleRequest(request(paletteRequest, { origin: 'https://feature.voxelmill.pages.dev' }), env);
    expect(preview.status).toBe(403);
    const missing = await handleRequest(new Request('https://api.voxelmill.com/v1/palette', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.10' },
      body: JSON.stringify(paletteRequest),
    }), env);
    expect(missing.status).toBe(403);
    expect(await missing.json()).toMatchObject({ error: { code: 'ORIGIN_REQUIRED' } });
    expect(env.CALLER_RATE_LIMITER.limit).not.toHaveBeenCalled();
    expect(env.AI.run).not.toHaveBeenCalled();
    const health = await handleRequest(new Request('https://api.voxelmill.com/health'), env);
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ ok: true, service: 'voxelmill-ai' });
  });

  it('publishes the disabled model-generation capability contract without provider secrets', async () => {
    const response = await handleRequest(new Request('https://api.voxelmill.com/v1/model-generation/capabilities'), environment());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ available: false, modes: ['text-to-3d', 'image-to-3d'], outputFormat: 'glb' });
  });

  it('fails closed when the feature kill switch is off', async () => {
    const env = environment();
    env.AI_PALETTE_ENABLED = 'false';
    const response = await handleRequest(request(), env);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: 'AI_DISABLED', retryable: false } });
    expect(env.CALLER_RATE_LIMITER.limit).not.toHaveBeenCalled();
    expect(env.AI_DAILY_ALLOWANCE.get).not.toHaveBeenCalled();
    expect(env.AI.run).not.toHaveBeenCalled();
  });

  it('fails closed when paid-inference configuration is absent or invalid', async () => {
    const env = environment();
    env.AI_DAILY_REQUEST_LIMIT = 'unlimited';
    const response = await handleRequest(request(), env);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: 'AI_CONFIGURATION_ERROR' } });
    expect(env.AI_DAILY_ALLOWANCE.get).not.toHaveBeenCalled();
    expect(env.AI.run).not.toHaveBeenCalled();
  });

  it('requires an uncommitted rate-limit HMAC secret before inference can be enabled', async () => {
    const env: Env = environment();
    delete env.AI_RATE_LIMIT_HASH_KEY;
    const response = await handleRequest(request(), env);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: 'AI_CONFIGURATION_ERROR' } });
    expect(env.CALLER_RATE_LIMITER.limit).not.toHaveBeenCalled();
    expect(env.AI_DAILY_ALLOWANCE.get).not.toHaveBeenCalled();
    expect(env.AI.run).not.toHaveBeenCalled();
  });

  it('blocks inference when the global daily allowance is exhausted', async () => {
    const env = environment();
    const allowanceFetch = vi.fn().mockResolvedValue(Response.json({
      allowed: false,
      used: 100,
      limit: 100,
      utcDay: '2026-07-20',
    }));
    env.AI_DAILY_ALLOWANCE.get.mockReturnValue({ fetch: allowanceFetch });
    const response = await handleRequest(request(), env);
    expect(response.status).toBe(429);
    expect(Number(response.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(await response.json()).toMatchObject({ error: { code: 'DAILY_ALLOWANCE_EXHAUSTED' } });
    expect(env.AI.run).not.toHaveBeenCalled();
  });

  it('fails closed when the global allowance cannot be verified', async () => {
    const env = environment();
    env.AI_DAILY_ALLOWANCE.get.mockReturnValue({
      fetch: vi.fn().mockRejectedValue(new Error('storage unavailable with #ff00ff and user content')),
    });
    const response = await handleRequest(request(), env);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: 'AI_BUDGET_UNAVAILABLE' } });
    expect(env.AI.run).not.toHaveBeenCalled();
  });

  it('rejects a malformed or mismatched allowance decision', async () => {
    const env = environment();
    env.AI_DAILY_ALLOWANCE.get.mockReturnValue({
      fetch: vi.fn().mockResolvedValue(Response.json({
        allowed: true,
        used: 1,
        limit: 999,
        utcDay: '2026-07-20',
      })),
    });
    const response = await handleRequest(request(), env);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: 'AI_BUDGET_UNAVAILABLE' } });
    expect(env.AI.run).not.toHaveBeenCalled();
  });

  it('uses the configured model and enforces the server deadline', async () => {
    vi.useFakeTimers();
    try {
      const env = environment();
      env.AI_PALETTE_MODEL = '@cf/meta/custom-palette-model';
      env.AI_REQUEST_DEADLINE_MS = '1000';
      env.AI.run.mockImplementation((_model, _input, options) => new Promise((_resolve, reject) => {
        options?.signal?.addEventListener('abort', () => reject(options.signal?.reason), { once: true });
      }));
      const pending = handleRequest(request(), env);
      await vi.waitFor(() => expect(env.AI.run).toHaveBeenCalledOnce(), { timeout: 500 });
      await vi.advanceTimersByTimeAsync(1001);
      const response = await pending;
      expect(response.status).toBe(504);
      expect(await response.json()).toMatchObject({ error: { code: 'AI_TIMEOUT' } });
      expect(env.AI.run).toHaveBeenCalledWith('@cf/meta/custom-palette-model', expect.any(Object), { signal: expect.any(AbortSignal) });
    } finally {
      vi.useRealTimers();
    }
  });

  it('fails closed when caller rate limiting is unavailable without logging request data', async () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const warningLog = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const env = environment();
    env.CALLER_RATE_LIMITER.limit.mockRejectedValue(new Error('icy industrial sci-fi #101010'));
    const response = await handleRequest(request(), env);
    expect(response.status).toBe(503);
    expect(response.headers.get('access-control-allow-origin')).toBe('https://voxelmill.com');
    expect(response.headers.get('x-request-id')).toBeTruthy();
    expect(await response.json()).toMatchObject({ error: { code: 'RATE_LIMIT_UNAVAILABLE' } });
    expect(errorLog).not.toHaveBeenCalled();
    expect(warningLog).not.toHaveBeenCalled();
    errorLog.mockRestore();
    warningLog.mockRestore();
  });

  it('uses only opaque server-derived limiter keys and emits no application logs', async () => {
    const infoLog = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const env = environment();
    const firstResponse = await handleRequest(request(paletteRequest, {
      'x-voxelmill-client': 'aaaaaaaaaaaaaaaa',
    }), env);
    const secondResponse = await handleRequest(request(paletteRequest, {
      'x-voxelmill-client': 'bbbbbbbbbbbbbbbb',
    }), env);
    expect(firstResponse.status).toBe(200);
    expect(secondResponse.status).toBe(200);
    expect(env.CALLER_RATE_LIMITER.limit).toHaveBeenCalledTimes(2);
    const firstKey = env.CALLER_RATE_LIMITER.limit.mock.calls[0][0].key;
    const secondKey = env.CALLER_RATE_LIMITER.limit.mock.calls[1][0].key;
    expect(firstKey).toBe(secondKey);
    expect(firstKey).toMatch(/^palette:caller:[0-9a-f]{64}$/u);
    expect(firstKey).not.toContain('203.0.113.10');
    expect(firstKey).not.toContain('aaaaaaaa');
    expect(env.EDGE_RATE_LIMITER.limit).toHaveBeenCalledWith({ key: 'palette:all-callers' });
    expect(infoLog).not.toHaveBeenCalled();
    infoLog.mockRestore();
  });

  it('permits local development without an edge address but fails closed for production', async () => {
    const local = await handleRequest(request(paletteRequest, {
      origin: 'http://127.0.0.1:4173',
      'cf-connecting-ip': '',
    }), environment());
    expect(local.status).toBe(200);

    const env = environment();
    const production = await handleRequest(request(paletteRequest, { 'cf-connecting-ip': '' }), env);
    expect(production.status).toBe(503);
    expect(await production.json()).toMatchObject({ error: { code: 'RATE_LIMIT_UNAVAILABLE' } });
    expect(env.AI_DAILY_ALLOWANCE.get).not.toHaveBeenCalled();
    expect(env.AI.run).not.toHaveBeenCalled();
  });

  it('answers a trusted preflight without allowing the removed client identity header', async () => {
    const env = environment();
    const response = await handleRequest(new Request('https://api.voxelmill.com/v1/palette', {
      method: 'OPTIONS',
      headers: { origin: 'https://voxelmill.com' },
    }), env);
    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-origin')).toBe('https://voxelmill.com');
    expect(response.headers.get('access-control-allow-headers')).toBe('content-type');

    const missing = await handleRequest(new Request('https://api.voxelmill.com/v1/palette', {
      method: 'OPTIONS',
    }), env);
    expect(missing.status).toBe(403);
    expect(await missing.json()).toMatchObject({ error: { code: 'ORIGIN_REQUIRED' } });

    const untrusted = await handleRequest(new Request('https://api.voxelmill.com/v1/palette', {
      method: 'OPTIONS',
      headers: { origin: 'https://attacker.example' },
    }), env);
    expect(untrusted.status).toBe(403);
    expect(await untrusted.json()).toMatchObject({ error: { code: 'ORIGIN_NOT_ALLOWED' } });
  });
});
