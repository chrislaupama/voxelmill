import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const root = process.env.VOXEL_TEST_ASSET_DIR;
if (!root) {
  console.error('Set VOXEL_TEST_ASSET_DIR to the private regression asset directory.');
  process.exit(1);
}

const manifest = JSON.parse(await readFile(new URL('../quality/real-assets.json', import.meta.url), 'utf8'));
const results = [];
let failed = false;
for (const asset of manifest.assets) {
  const file = path.resolve(root, asset.relativePath);
  try {
    const bytes = await readFile(file);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const valid = bytes.length === asset.bytes && sha256 === asset.sha256;
    failed ||= !valid;
    results.push({
      id: asset.id,
      relativePath: asset.relativePath,
      valid,
      bytes: bytes.length,
      sha256,
    });
  } catch (error) {
    failed = true;
    results.push({
      id: asset.id,
      relativePath: asset.relativePath,
      valid: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

console.log(JSON.stringify({ rootConfigured: true, assets: results }, null, 2));
if (failed) process.exit(1);
