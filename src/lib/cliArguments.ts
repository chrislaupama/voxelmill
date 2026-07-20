export type CliExportFormat = 'vox' | 'qb' | 'glb' | 'json';

export interface CliArguments {
  input: string;
  format: CliExportFormat;
  output?: string;
}

const FORMATS = new Set<CliExportFormat>(['vox', 'qb', 'glb', 'json']);

export function parseCliArguments(args: readonly string[]): CliArguments {
  let input: string | undefined;
  let output: string | undefined;
  let format: CliExportFormat = 'vox';

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--format' || argument === '--output') {
      const value = args[index + 1];
      if (!value || value.startsWith('-')) throw new Error(`${argument} requires a value.`);
      index += 1;
      if (argument === '--format') {
        const normalized = value.toLowerCase();
        if (!FORMATS.has(normalized as CliExportFormat)) throw new Error(`Unsupported format: ${normalized}`);
        format = normalized as CliExportFormat;
      } else {
        output = value;
      }
      continue;
    }
    if (argument.startsWith('-')) throw new Error(`Unknown option: ${argument}`);
    if (input) throw new Error(`Unexpected extra input: ${argument}`);
    input = argument;
  }

  if (!input) throw new Error('A .voxelmill project path is required.');
  if (!input.toLowerCase().endsWith('.voxelmill')) {
    throw new Error('The CLI accepts a saved .voxelmill project as input.');
  }
  return { input, format, output };
}
