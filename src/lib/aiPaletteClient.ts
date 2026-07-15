import {
  parseAiPaletteResponse,
  type AiPaletteRequest,
  type AiPaletteResponse,
} from './aiPaletteContract';

const CLIENT_STORAGE_KEY = 'voxelmill-ai-client';
const AI_PALETTE_ENDPOINT = import.meta.env.VITE_AI_PALETTE_ENDPOINT || 'https://api.voxelmill.com/v1/palette';

function clientId() {
  try {
    const existing = window.localStorage.getItem(CLIENT_STORAGE_KEY);
    if (existing) return existing;
    const created = crypto.randomUUID();
    window.localStorage.setItem(CLIENT_STORAGE_KEY, created);
    return created;
  } catch {
    return crypto.randomUUID();
  }
}

export async function requestAiPalettes(request: AiPaletteRequest, signal?: AbortSignal): Promise<AiPaletteResponse> {
  const response = await fetch(AI_PALETTE_ENDPOINT, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-voxelmill-client': clientId(),
    },
    body: JSON.stringify(request),
    signal,
  });
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new Error(response.ok ? 'The AI palette service returned an unreadable response.' : 'AI Palette Studio is temporarily unavailable.');
  }
  if (!response.ok) {
    const message = typeof body === 'object' && body !== null && 'error' in body
      && typeof body.error === 'object' && body.error !== null && 'message' in body.error
      && typeof body.error.message === 'string'
      ? body.error.message
      : 'AI Palette Studio is temporarily unavailable.';
    throw new Error(message);
  }
  return parseAiPaletteResponse(body, request.targetColorCount);
}
