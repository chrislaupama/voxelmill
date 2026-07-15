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
  return {
    AI: { run: vi.fn().mockResolvedValue(response) },
    CLIENT_RATE_LIMITER: { limit: vi.fn().mockResolvedValue({ success: true }) },
    IP_RATE_LIMITER: { limit: vi.fn().mockResolvedValue({ success: true }) },
  } satisfies Env;
}

function request(body: unknown = paletteRequest, headers: Record<string, string> = {}) {
  return new Request('https://api.voxelmill.com/v1/palette', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: 'https://voxelmill.com',
      'x-voxelmill-client': '018f5d52-a135-7cc6-b55d-8f92f71e4abc',
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

describe('VoxelMill AI Worker', () => {
  it('returns three validated palettes, reinjects locked colors, and forwards cancellation', async () => {
    const env = environment();
    const paletteHttpRequest = request();
    const response = await handleRequest(paletteHttpRequest, env);
    expect(response.status).toBe(200);
    expect(response.headers.get('access-control-allow-origin')).toBe('https://voxelmill.com');
    const body = await response.json() as { suggestions: { colors: string[] }[] };
    expect(body.suggestions).toHaveLength(3);
    expect(body.suggestions.every((suggestion) => suggestion.colors[0] === '#101010')).toBe(true);
    expect(env.AI.run).toHaveBeenCalledOnce();
    expect(env.AI.run).toHaveBeenCalledWith(expect.any(String), expect.any(Object), { signal: paletteHttpRequest.signal });
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
    env.IP_RATE_LIMITER.limit = vi.fn().mockResolvedValue({ success: false });
    const response = await handleRequest(request(), env);
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('60');
    expect(env.AI.run).not.toHaveBeenCalled();
  });

  it('rejects untrusted browser origins and supports a public health check', async () => {
    const env = environment();
    const rejected = await handleRequest(request(paletteRequest, { origin: 'https://attacker.example' }), env);
    expect(rejected.status).toBe(403);
    const health = await handleRequest(new Request('https://api.voxelmill.com/health'), env);
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ ok: true, service: 'voxelmill-ai' });
  });

  it('publishes the disabled model-generation capability contract without provider secrets', async () => {
    const response = await handleRequest(new Request('https://api.voxelmill.com/v1/model-generation/capabilities'), environment());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ available: false, modes: ['text-to-3d', 'image-to-3d'], outputFormat: 'glb' });
  });
});
