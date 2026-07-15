import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const JSON_CHUNK = 0x4e4f534a;
const TRIANGLES = 4;
const TRIANGLE_STRIP = 5;
const TRIANGLE_FAN = 6;

function parseGlb(bytes, source) {
  if (bytes.length < 20 || bytes.toString('utf8', 0, 4) !== 'glTF') {
    throw new Error(`${source} is not a binary glTF file`);
  }
  const version = bytes.readUInt32LE(4);
  const declaredLength = bytes.readUInt32LE(8);
  if (declaredLength !== bytes.length) {
    throw new Error(`${source} declares ${declaredLength} bytes but contains ${bytes.length}`);
  }

  let cursor = 12;
  let document;
  while (cursor + 8 <= bytes.length) {
    const length = bytes.readUInt32LE(cursor);
    const type = bytes.readUInt32LE(cursor + 4);
    const end = cursor + 8 + length;
    if (end > bytes.length) throw new Error(`${source} contains a truncated GLB chunk`);
    if (type === JSON_CHUNK) {
      document = JSON.parse(bytes.toString('utf8', cursor + 8, end).replace(/\0+$/u, '').trimEnd());
      break;
    }
    cursor = end;
  }
  if (!document) throw new Error(`${source} does not contain a JSON chunk`);
  return { version, document };
}

function primitiveTriangles(primitive, accessors) {
  const accessor = accessors[primitive.indices ?? primitive.attributes?.POSITION];
  const count = accessor?.count ?? 0;
  const mode = primitive.mode ?? TRIANGLES;
  if (mode === TRIANGLES) return Math.floor(count / 3);
  if (mode === TRIANGLE_STRIP || mode === TRIANGLE_FAN) return Math.max(0, count - 2);
  return 0;
}

function summarize(file, bytes, version, document) {
  const primitives = (document.meshes ?? []).flatMap((mesh) => mesh.primitives ?? []);
  const accessors = document.accessors ?? [];
  const extensions = new Set([
    ...(document.extensionsUsed ?? []),
    ...(document.extensionsRequired ?? []),
  ]);
  return {
    file: path.basename(file),
    bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    glbVersion: version,
    gltfVersion: document.asset?.version ?? null,
    generator: document.asset?.generator ?? null,
    scenes: document.scenes?.length ?? 0,
    nodes: document.nodes?.length ?? 0,
    meshes: document.meshes?.length ?? 0,
    primitives: primitives.length,
    triangles: primitives.reduce((total, primitive) => total + primitiveTriangles(primitive, accessors), 0),
    materials: document.materials?.length ?? 0,
    textures: document.textures?.length ?? 0,
    images: document.images?.length ?? 0,
    animations: document.animations?.length ?? 0,
    skins: document.skins?.length ?? 0,
    extensions: [...extensions].sort(),
  };
}

const files = process.argv.slice(2);
if (!files.length) {
  console.error('Usage: npm run inventory:glb -- model.glb [more.glb ...]');
  process.exit(1);
}

const inventory = [];
for (const file of files) {
  const bytes = await readFile(file);
  const { version, document } = parseGlb(bytes, file);
  inventory.push(summarize(file, bytes, version, document));
}
console.log(JSON.stringify(inventory, null, 2));
