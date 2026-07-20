#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseCliArguments } from './lib/cliArguments';
import { encodeGlb } from './lib/glbExport';
import { decodeVoxelMillProject } from './lib/projectFormat';
import { encodeQb } from './lib/qbExport';
import { encodeVox } from './lib/voxExport';

function usage(message?: string): never {
  if (message) console.error(message);
  console.error('Usage: npm run cli -- <project.voxelmill> [--format vox|qb|glb|json] [--output path]');
  process.exit(1);
}

let parsed: ReturnType<typeof parseCliArguments>;
try {
  parsed = parseCliArguments(process.argv.slice(2));
} catch (error) {
  usage(error instanceof Error ? error.message : 'Invalid command-line arguments.');
}
const { input, format, output: requestedOutput } = parsed!;

const file = await readFile(input);
const buffer = file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength) as ArrayBuffer;
const project = decodeVoxelMillProject(buffer);
const defaultOutput = `${path.join(path.dirname(input), path.basename(input, path.extname(input)))}.${format}`;
const output = requestedOutput ?? defaultOutput;
const bytes = format === 'vox'
  ? encodeVox(project.model)
  : format === 'qb'
    ? encodeQb(project.model)
    : format === 'glb'
      ? encodeGlb(project.model)
    : new TextEncoder().encode(`${JSON.stringify(project, null, 2)}\n`);
await writeFile(output, bytes);
console.log(`${output} · ${project.model.voxels.length.toLocaleString()} voxels · ${project.model.palette.length} colors`);
