import { describe, expect, it } from 'vitest';
import { parseCliArguments } from './cliArguments';

describe('parseCliArguments', () => {
  it('accepts options before or after the project path', () => {
    expect(parseCliArguments(['--format', 'glb', 'model.voxelmill'])).toEqual({
      input: 'model.voxelmill', format: 'glb', output: undefined,
    });
    expect(parseCliArguments(['model.voxelmill', '--output', 'build/model.vox'])).toEqual({
      input: 'model.voxelmill', format: 'vox', output: 'build/model.vox',
    });
  });

  it('normalizes supported formats', () => {
    expect(parseCliArguments(['model.voxelmill', '--format', 'GLB']).format).toBe('glb');
  });

  it('rejects missing flag values, unknown flags, and extra inputs', () => {
    expect(() => parseCliArguments(['model.voxelmill', '--format'])).toThrow(/requires a value/u);
    expect(() => parseCliArguments(['model.voxelmill', '--output', '--format', 'vox'])).toThrow(/requires a value/u);
    expect(() => parseCliArguments(['model.voxelmill', '--wat'])).toThrow(/Unknown option/u);
    expect(() => parseCliArguments(['one.voxelmill', 'two.voxelmill'])).toThrow(/Unexpected extra input/u);
  });

  it('requires a supported project path and format', () => {
    expect(() => parseCliArguments([])).toThrow(/project path/u);
    expect(() => parseCliArguments(['model.vox'])).toThrow(/accepts a saved/u);
    expect(() => parseCliArguments(['model.voxelmill', '--format', 'png'])).toThrow(/Unsupported format/u);
  });
});
