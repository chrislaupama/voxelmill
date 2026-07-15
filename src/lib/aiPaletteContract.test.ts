import { describe, expect, it } from 'vitest';
import type { VoxelModel } from '../types';
import {
  buildAiPaletteRequest,
  parseAiPaletteRequest,
  parseAiPaletteResponse,
} from './aiPaletteContract';
import { packVoxelCoordinate } from './voxelIndex';

const model: VoxelModel = {
  sourceName: 'palette.glb',
  voxelSize: 1,
  size: { x: 3, y: 1, z: 1 },
  palette: [{ r: 255, g: 0, b: 0 }, { r: 0, g: 0, b: 255 }],
  voxels: [
    { x: 0, y: 0, z: 0, r: 255, g: 0, b: 0, colorIndex: 0 },
    { x: 1, y: 0, z: 0, r: 255, g: 0, b: 0, colorIndex: 0 },
    { x: 2, y: 0, z: 0, r: 0, g: 0, b: 255, colorIndex: 1 },
  ],
};

describe('AI palette contract', () => {
  it('builds a histogram without voxel coordinates or geometry', () => {
    const request = buildAiPaletteRequest(model, '  icy sci-fi metal  ', 4, new Set(['#ff0000']));
    expect(request.prompt).toBe('icy sci-fi metal');
    expect(request.palette).toEqual([
      { hex: '#ff0000', count: 2, locked: true },
      { hex: '#0000ff', count: 1, locked: false },
    ]);
    expect(JSON.stringify(request)).not.toMatch(/voxels|sourceName|"x"|"y"|"z"/u);
  });

  it('limits a selection histogram to selected voxels', () => {
    const selection = new Set([packVoxelCoordinate(model.voxels[2])]);
    expect(buildAiPaletteRequest(model, 'warm accent', 2, new Set(), selection).palette)
      .toEqual([{ hex: '#0000ff', count: 1, locked: false }]);
  });

  it('rejects malformed requests and impossible lock counts', () => {
    expect(() => parseAiPaletteRequest({ version: 1, prompt: '', targetColorCount: 2, palette: [] })).toThrow();
    expect(() => parseAiPaletteRequest({
      version: 1,
      prompt: 'style',
      targetColorCount: 2,
      palette: [
        { hex: '#000000', count: 1, locked: true },
        { hex: '#111111', count: 1, locked: true },
        { hex: '#222222', count: 1, locked: true },
      ],
    })).toThrow(/unlocked color slot/u);
    expect(() => parseAiPaletteRequest({
      version: 1,
      prompt: 'style',
      targetColorCount: 2,
      palette: [
        { hex: '#000000', count: 1, locked: true },
        { hex: '#ffffff', count: 1, locked: true },
      ],
    })).toThrow(/unlocked color slot/u);
  });

  it('validates exact candidate lengths and unique canonical colors', () => {
    const suggestion = (id: string) => ({ id, name: `Look ${id}`, description: 'A coherent tonal ramp.', colors: ['#101820', '#d8f3ff'] });
    expect(parseAiPaletteResponse({
      version: 1,
      requestId: 'request-1',
      model: '@cf/test',
      suggestions: [suggestion('a'), suggestion('b'), suggestion('c')],
    }, 2).suggestions).toHaveLength(3);
    expect(() => parseAiPaletteResponse({
      version: 1,
      requestId: 'request-1',
      model: '@cf/test',
      suggestions: [suggestion('a'), suggestion('b'), { ...suggestion('c'), colors: ['#101820', '#101820'] }],
    }, 2)).toThrow(/duplicate/u);
  });
});
