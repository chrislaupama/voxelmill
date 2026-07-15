import type { RGB, VoxelModel } from '../types';
import { packVoxelCoordinate } from './voxelIndex';

export const AI_PALETTE_VERSION = 1 as const;
export const AI_PALETTE_CANDIDATE_COUNT = 3;
export const AI_PALETTE_MIN_COLORS = 2;
export const AI_PALETTE_MAX_COLORS = 32;
export const AI_PALETTE_MAX_PROMPT_LENGTH = 500;

export interface AiPaletteSourceColor {
  hex: string;
  count: number;
  locked: boolean;
}

export interface AiPaletteRequest {
  version: typeof AI_PALETTE_VERSION;
  prompt: string;
  targetColorCount: number;
  palette: AiPaletteSourceColor[];
}

export interface AiPaletteSuggestion {
  id: string;
  name: string;
  description: string;
  colors: string[];
}

export interface AiPaletteResponse {
  version: typeof AI_PALETTE_VERSION;
  requestId: string;
  model: string;
  suggestions: AiPaletteSuggestion[];
}

const HEX_COLOR = /^#[0-9a-f]{6}$/u;

export const rgbToHex = (color: RGB) =>
  `#${[color.r, color.g, color.b].map((channel) => channel.toString(16).padStart(2, '0')).join('')}`;

export const hexToRgb = (value: string): RGB => ({
  r: Number.parseInt(value.slice(1, 3), 16),
  g: Number.parseInt(value.slice(3, 5), 16),
  b: Number.parseInt(value.slice(5, 7), 16),
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const hasOnlyKeys = (value: Record<string, unknown>, keys: string[]) =>
  Object.keys(value).every((key) => keys.includes(key));

const boundedString = (value: unknown, minimum: number, maximum: number) =>
  typeof value === 'string' && value.trim().length >= minimum && value.trim().length <= maximum;

function parseSourceColor(value: unknown): AiPaletteSourceColor {
  if (!isRecord(value) || !hasOnlyKeys(value, ['hex', 'count', 'locked'])
    || typeof value.hex !== 'string' || !HEX_COLOR.test(value.hex)
    || !Number.isInteger(value.count) || (value.count as number) < 1 || (value.count as number) > 2_147_483_647
    || typeof value.locked !== 'boolean') {
    throw new Error('Each palette entry must contain a canonical hex color, positive count, and lock state.');
  }
  return { hex: value.hex, count: value.count as number, locked: value.locked };
}

export function parseAiPaletteRequest(value: unknown): AiPaletteRequest {
  if (!isRecord(value) || !hasOnlyKeys(value, ['version', 'prompt', 'targetColorCount', 'palette'])
    || value.version !== AI_PALETTE_VERSION
    || !boundedString(value.prompt, 1, AI_PALETTE_MAX_PROMPT_LENGTH)
    || !Number.isInteger(value.targetColorCount)
    || (value.targetColorCount as number) < AI_PALETTE_MIN_COLORS
    || (value.targetColorCount as number) > AI_PALETTE_MAX_COLORS
    || !Array.isArray(value.palette) || value.palette.length < 1 || value.palette.length > 255) {
    throw new Error('The AI palette request is malformed.');
  }
  const palette = value.palette.map(parseSourceColor);
  const lockedCount = new Set(palette.filter((entry) => entry.locked).map((entry) => entry.hex)).size;
  if (lockedCount >= (value.targetColorCount as number)) {
    throw new Error('The target palette must leave one unlocked color slot after preserving every locked color.');
  }
  return {
    version: AI_PALETTE_VERSION,
    prompt: (value.prompt as string).trim(),
    targetColorCount: value.targetColorCount as number,
    palette,
  };
}

function parseSuggestion(value: unknown, index: number, targetColorCount: number): AiPaletteSuggestion {
  if (!isRecord(value) || !hasOnlyKeys(value, ['id', 'name', 'description', 'colors'])
    || !boundedString(value.id, 1, 64) || !boundedString(value.name, 1, 60)
    || !boundedString(value.description, 1, 240) || !Array.isArray(value.colors)
    || value.colors.length !== targetColorCount
    || !value.colors.every((color) => typeof color === 'string' && HEX_COLOR.test(color))) {
    throw new Error(`AI palette suggestion ${index + 1} is malformed.`);
  }
  const colors = value.colors as string[];
  if (new Set(colors).size !== colors.length) throw new Error(`AI palette suggestion ${index + 1} contains duplicate colors.`);
  return {
    id: value.id as string,
    name: (value.name as string).trim(),
    description: (value.description as string).trim(),
    colors,
  };
}

export function parseAiPaletteResponse(value: unknown, targetColorCount: number): AiPaletteResponse {
  if (!isRecord(value) || !hasOnlyKeys(value, ['version', 'requestId', 'model', 'suggestions'])
    || value.version !== AI_PALETTE_VERSION || !boundedString(value.requestId, 1, 80)
    || !boundedString(value.model, 1, 120) || !Array.isArray(value.suggestions)
    || value.suggestions.length !== AI_PALETTE_CANDIDATE_COUNT) {
    throw new Error('The AI palette service returned an invalid response.');
  }
  return {
    version: AI_PALETTE_VERSION,
    requestId: value.requestId as string,
    model: value.model as string,
    suggestions: value.suggestions.map((suggestion, index) => parseSuggestion(suggestion, index, targetColorCount)),
  };
}

export function buildAiPaletteRequest(
  model: VoxelModel,
  prompt: string,
  targetColorCount: number,
  lockedColors: ReadonlySet<string>,
  selection?: ReadonlySet<number>,
): AiPaletteRequest {
  const counts = new Map<number, number>();
  for (const voxel of model.voxels) {
    if (selection && !selection.has(packVoxelCoordinate(voxel))) continue;
    counts.set(voxel.colorIndex, (counts.get(voxel.colorIndex) ?? 0) + 1);
  }
  const palette = [...counts.entries()]
    .sort(([left], [right]) => left - right)
    .map(([index, count]) => {
      const hex = rgbToHex(model.palette[index]);
      return { hex, count, locked: lockedColors.has(hex) };
    });
  return parseAiPaletteRequest({ version: AI_PALETTE_VERSION, prompt, targetColorCount, palette });
}
