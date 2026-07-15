#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { decodeVoxelMillProject } from './lib/projectFormat';
import { encodeQb } from './lib/qbExport';
import { encodeVox } from './lib/voxExport';

function usage(message?: string): never {
  if (message) console.error(message);
  console.error('Usage: npm run cli -- <project.voxelmill> [--format vox|qb|json] [--output path]');
  process.exit(1);
}

const args = process.argv.slice(2);
const input = args.find((argument) => !argument.startsWith('-'));
if (!input) usage();
const valueAfter = (flag: string) => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
};
const format = (valueAfter('--format') ?? 'vox').toLowerCase();
if (!['vox', 'qb', 'json'].includes(format)) usage(`Unsupported format: ${format}`);
if (!input.toLowerCase().endsWith('.voxelmill')) usage('The CLI accepts a saved .voxelmill project as input.');

const file = await readFile(input);
const buffer = file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength) as ArrayBuffer;
const project = decodeVoxelMillProject(buffer);
const defaultOutput = `${path.join(path.dirname(input), path.basename(input, path.extname(input)))}.${format}`;
const output = valueAfter('--output') ?? defaultOutput;
const bytes = format === 'vox'
  ? encodeVox(project.model)
  : format === 'qb'
    ? encodeQb(project.model)
    : new TextEncoder().encode(`${JSON.stringify(project, null, 2)}\n`);
await writeFile(output, bytes);
console.log(`${output} · ${project.model.voxels.length.toLocaleString()} voxels · ${project.model.palette.length} colors`);
