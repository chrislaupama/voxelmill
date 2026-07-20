import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { deflateSync } from 'node:zlib';
import { expect, test, type Locator } from '@playwright/test';

interface RealAssetManifest {
  assetRootEnvironmentVariable: string;
  assets: Array<{
    id: string;
    relativePath: string;
    bytes: number;
    sha256: string;
    triangles: number;
    materials: number;
    textures: number;
  }>;
}

const manifest = JSON.parse(
  readFileSync(new URL('../quality/real-assets.json', import.meta.url), 'utf8'),
) as RealAssetManifest;
const rocket = manifest.assets.find((asset) => asset.id === 'rocket-textured-highpoly');
const assetRoot = process.env[manifest.assetRootEnvironmentVariable];

function parseInteger(value: string) {
  return Number.parseInt(value.replaceAll(',', ''), 10);
}

const MATERIAL_REFERENCE_COLORS = [
  [14, 17, 21], [28, 32, 38], [43, 48, 56], [61, 68, 77], [82, 90, 99],
  [108, 117, 126], [143, 150, 155], [202, 201, 193],
  [48, 10, 15], [73, 14, 20], [99, 19, 25], [128, 27, 31], [160, 39, 36], [195, 57, 40],
  [105, 42, 10], [143, 61, 12], [188, 87, 17], [235, 126, 29],
  [28, 108, 114], [214, 173, 53],
] as const;

function crc32(bytes: Buffer) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer) {
  const name = Buffer.from(type, 'ascii');
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  name.copy(chunk, 4);
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(Buffer.concat([name, data])), 8 + data.length);
  return chunk;
}

function materialReferencePng() {
  const columns = 5;
  const rows = 4;
  const cellSize = 24;
  const width = columns * cellSize;
  const height = rows * cellSize;
  const stride = width * 4 + 1;
  const pixels = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    const rowOffset = y * stride;
    pixels[rowOffset] = 0;
    for (let x = 0; x < width; x += 1) {
      const color = MATERIAL_REFERENCE_COLORS[Math.floor(y / cellSize) * columns + Math.floor(x / cellSize)];
      const offset = rowOffset + 1 + x * 4;
      pixels[offset] = color[0];
      pixels[offset + 1] = color[1];
      pixels[offset + 2] = color[2];
      pixels[offset + 3] = 255;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(pixels, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

async function strongMetric(container: Locator, label: string) {
  return (await container.locator('.ai-metrics span').filter({ hasText: label }).locator('strong').first().innerText()).trim();
}

function parseRatio(value: string) {
  return value.split('/').map((part) => parseInteger(part.trim()));
}

function cssRgb(value: string) {
  const channels = value.match(/\d+(?:\.\d+)?/gu)?.slice(0, 3).map(Number) ?? [];
  if (channels.length !== 3) throw new Error(`Expected an RGB CSS color, received ${value}.`);
  return channels;
}

function paletteShape(colors: string[]) {
  const parsed = colors.map(cssRgb);
  const luminances = parsed.map(([r, g, b]) => r * 0.2126 + g * 0.7152 + b * 0.0722);
  return {
    distinct: new Set(colors).size,
    neutral: parsed.filter(([r, g, b]) => Math.max(r, g, b) - Math.min(r, g, b) <= 22).length,
    warm: parsed.filter(([r, g, b]) => r - g >= 22 && r - b >= 22).length,
    luminanceSpan: Math.max(...luminances) - Math.min(...luminances),
  };
}

test.describe('private real-asset quality gate', () => {
  test.skip(
    !assetRoot,
    `Set ${manifest.assetRootEnvironmentVariable} to run the authorized private-asset gate.`,
  );

  test('voxelizes the textured rocket at the 80 / 20 defaults', async ({ page }, testInfo) => {
    expect(rocket, 'quality/real-assets.json must contain the rocket regression asset').toBeTruthy();
    const asset = rocket!;
    const assetPath = path.resolve(assetRoot!, asset.relativePath);
    const bytes = readFileSync(assetPath);

    expect(bytes.byteLength, 'private fixture byte length must match the manifest').toBe(asset.bytes);
    expect(
      createHash('sha256').update(bytes).digest('hex'),
      'private fixture SHA-256 must match the manifest',
    ).toBe(asset.sha256);

    const browserErrors: string[] = [];
    page.on('pageerror', (error) => browserErrors.push(`pageerror: ${error.message}`));
    page.on('console', (message) => {
      if (message.type() === 'error') browserErrors.push(`console: ${message.text()}`);
    });
    page.on('requestfailed', (request) => {
      browserErrors.push(`request: ${request.method()} ${request.url()} (${request.failure()?.errorText ?? 'failed'})`);
    });

    const viteFsPath = `/@fs/${assetPath.replaceAll(path.sep, '/').replace(/^\/+/, '')}`;
    const query = new URLSearchParams({ fixture: viteFsPath });
    const startedAt = Date.now();
    await page.goto(`/?${query.toString()}`);

    await expect(page).toHaveTitle(/VoxelMill/);
    await expect(page.getByLabel('Resolution')).toHaveValue('80');
    await expect(page.getByLabel('Palette size')).toHaveValue('20');
    await expect(page.locator('.source-section .file-copy strong')).toHaveText(path.basename(asset.relativePath));
    await expect(page.locator('.source-section .file-copy span')).toContainText(
      `${asset.triangles.toLocaleString('en-US')} triangles`,
    );

    const result = page.locator('.result-section');
    await expect(result).toBeVisible({ timeout: 280_000 });
    await expect(page.getByRole('progressbar', { name: 'Voxel conversion' })).toHaveCount(0);
    await expect(page.getByRole('alert')).toHaveCount(0);
    const durationMs = Date.now() - startedAt;

    const resultValues = await result.locator('.result-grid > div').evaluateAll((nodes) => Object.fromEntries(
      nodes.map((node) => [
        node.querySelector('span')?.textContent?.trim() ?? '',
        node.querySelector('strong')?.textContent?.trim() ?? '',
      ]),
    ));
    const sourceStats = await page.locator('.source-section .mini-stats span').allTextContents();
    const paletteSwatches = await result.locator('.palette-strip span').evaluateAll((nodes) => (
      nodes.map((node) => getComputedStyle(node).backgroundColor)
    ));

    const dimensions = String(resultValues.Dimensions ?? '')
      .split('×')
      .map((part) => parseInteger(part.trim()));
    const voxelCount = parseInteger(String(resultValues.Voxels ?? ''));
    const paletteCount = parseInteger(String(resultValues.Palette ?? ''));
    const distinctSwatchCount = new Set(paletteSwatches).size;
    const visibleSourceStat = (label: string) => parseInteger(
      sourceStats.find((value) => value.trim().endsWith(` ${label}`)) ?? '',
    );
    const visibleMeshes = visibleSourceStat('meshes');
    const visibleMaterials = visibleSourceStat('materials');
    const visibleTextures = visibleSourceStat('textures');

    expect(dimensions).toHaveLength(3);
    expect(dimensions.every((value) => Number.isInteger(value) && value > 0)).toBe(true);
    // The converter surrounds the configured 80-cell extent with one guard cell per side.
    expect(Math.max(...dimensions), 'the 80-cell extent may include only its two guard cells').toBe(82);
    expect(voxelCount).toBeGreaterThan(0);
    expect(voxelCount).toBeLessThanOrEqual(dimensions[0] * dimensions[1] * dimensions[2]);
    expect(paletteCount, 'the textured rocket should fill the 20-color default palette').toBe(20);
    expect(paletteSwatches).toHaveLength(20);
    expect(distinctSwatchCount, 'the generated palette must not contain duplicate swatches').toBe(20);
    expect(visibleMeshes).toBeGreaterThan(0);
    expect(visibleMaterials).toBe(asset.materials);
    // The GLB inventory counts every texture object; the loader reports textures used for color/emission.
    expect(visibleTextures).toBeGreaterThan(0);
    expect(visibleTextures).toBeLessThanOrEqual(asset.textures);

    const metrics = {
      schemaVersion: 1,
      assetId: asset.id,
      sourceFile: path.basename(asset.relativePath),
      sourceTriangles: asset.triangles,
      visibleSourceMeshes: visibleMeshes,
      visibleSourceMaterials: visibleMaterials,
      visibleSourceTextures: visibleTextures,
      resolution: 80,
      requestedPaletteColors: 20,
      durationMs,
      outputVoxels: voxelCount,
      outputDimensions: dimensions,
      outputPaletteColors: paletteCount,
      distinctPaletteSwatches: distinctSwatchCount,
      paletteSwatches,
      browserProject: testInfo.project.name,
    };
    const metricsPath = testInfo.outputPath('rocket-80x20.metrics.json');
    await result.scrollIntoViewIfNeeded();
    const screenshotPath = testInfo.outputPath('rocket-80x20.png');
    const originalScreenshot = await page.screenshot({ fullPage: true });

    await page.getByRole('button', { name: 'Open Palette Studio' }).click();
    const referenceMode = page.getByRole('button', { name: /Reference image.*no AI.*no bill/i });
    await expect(referenceMode).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByLabel('Target colors')).toHaveValue('20');
    const referenceInput = page.getByLabel('Reference image file');
    await expect(referenceInput).toBeAttached();
    await page.waitForLoadState('networkidle');

    const httpRequestsAfterReferenceSelection: string[] = [];
    page.on('request', (request) => {
      if (/^https?:/iu.test(request.url())) httpRequestsAfterReferenceSelection.push(request.url());
    });
    await referenceInput.setInputFiles({
      name: 'voxelmill-material-reference.png',
      mimeType: 'image/png',
      buffer: materialReferencePng(),
    });

    const candidateStrip = page.getByLabel('Reference image prepared colors');
    await expect(candidateStrip).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('.ai-studio')).toHaveAttribute('aria-busy', 'false');
    await expect(page.locator('.ai-studio [role="alert"]')).toHaveCount(0);
    const candidateSwatches = await candidateStrip.locator('i').evaluateAll((nodes) => (
      nodes.map((node) => getComputedStyle(node).backgroundColor)
    ));
    const candidateShape = paletteShape(candidateSwatches);

    const extraction = page.getByLabel('Reference extraction diagnostics');
    const extractedSwatches = parseInteger(await strongMetric(extraction, 'swatches'));
    const sampledPixels = parseInteger(await strongMetric(extraction, 'pixels sampled'));
    const [familiesKept, familiesDetected] = parseRatio(await strongMetric(extraction, 'families kept'));
    const [accentsKept, accentsDetected] = parseRatio(await strongMetric(extraction, 'accents kept'));
    const meanExtractionError = Number(await strongMetric(extraction, 'mean error'));
    const p95ExtractionError = Number(await strongMetric(extraction, 'p95 error'));

    const previewSummary = page.locator('.ai-preview-summary');
    const changedVoxels = parseInteger(await strongMetric(previewSummary, 'voxels changed'));
    const [usedColors, preparedColors] = parseRatio(await strongMetric(previewSummary, 'used / prepared'));
    const toneOrderRetention = parseInteger(await strongMetric(previewSummary, 'tone order'));
    const materialRamps = parseInteger(await strongMetric(previewSummary, 'material ramps'));
    const lightnessRange = parseInteger(await strongMetric(previewSummary, 'light range'));
    const minimumColorSeparation = Number(await strongMetric(previewSummary, 'min separation'));
    const mappingRows = page.locator('.ai-mapping-row');

    expect(extractedSwatches).toBeGreaterThanOrEqual(16);
    expect(extractedSwatches).toBeLessThanOrEqual(20);
    expect(sampledPixels).toBe(120 * 96);
    expect(familiesDetected).toBeGreaterThanOrEqual(3);
    expect(familiesKept).toBe(familiesDetected);
    expect(accentsDetected).toBeGreaterThanOrEqual(1);
    expect(accentsKept).toBe(accentsDetected);
    expect(meanExtractionError).toBeLessThanOrEqual(2);
    expect(p95ExtractionError).toBeLessThanOrEqual(4);
    expect(candidateSwatches).toHaveLength(preparedColors);
    expect(candidateShape.distinct).toBe(candidateSwatches.length);
    expect(candidateShape.neutral).toBeGreaterThanOrEqual(4);
    expect(candidateShape.warm).toBeGreaterThanOrEqual(4);
    expect(candidateShape.luminanceSpan).toBeGreaterThan(100);
    expect(changedVoxels).toBeGreaterThan(0);
    expect(changedVoxels).toBeLessThanOrEqual(voxelCount);
    expect(usedColors).toBeGreaterThan(0);
    expect(usedColors).toBeLessThanOrEqual(preparedColors);
    expect(preparedColors).toBeLessThanOrEqual(20);
    expect(toneOrderRetention).toBeGreaterThanOrEqual(70);
    expect(materialRamps).toBeGreaterThanOrEqual(2);
    expect(lightnessRange).toBeGreaterThanOrEqual(30);
    expect(minimumColorSeparation).toBeGreaterThan(0);
    await expect(mappingRows).toHaveCount(paletteCount);
    expect(httpRequestsAfterReferenceSelection, 'reference extraction must remain entirely local').toEqual([]);

    await page.getByRole('button', { name: /^Apply to model$/i }).click();
    await expect.poll(async () => result.locator('.palette-strip span').evaluateAll((nodes) => (
      nodes.map((node) => getComputedStyle(node).backgroundColor)
    ))).not.toEqual(paletteSwatches);
    const appliedSwatches = await result.locator('.palette-strip span').evaluateAll((nodes) => (
      nodes.map((node) => getComputedStyle(node).backgroundColor)
    ));
    const appliedShape = paletteShape(appliedSwatches);
    const candidateSet = new Set(candidateSwatches);
    expect(appliedSwatches).toHaveLength(usedColors);
    expect(appliedSwatches.length).toBeGreaterThanOrEqual(4);
    expect(appliedShape.distinct).toBe(appliedSwatches.length);
    expect(appliedShape.neutral).toBeGreaterThanOrEqual(2);
    expect(appliedShape.warm).toBeGreaterThanOrEqual(1);
    expect(appliedShape.luminanceSpan).toBeGreaterThan(80);
    expect(appliedSwatches.every((color) => candidateSet.has(color))).toBe(true);
    expect(httpRequestsAfterReferenceSelection, 'reference apply must remain entirely local').toEqual([]);

    const referenceMetrics = {
      schemaVersion: 1,
      assetId: asset.id,
      referenceImage: {
        generatedInMemory: true,
        width: 120,
        height: 96,
        sourceSwatches: MATERIAL_REFERENCE_COLORS.length,
      },
      extraction: {
        extractedSwatches,
        sampledPixels,
        familiesKept,
        familiesDetected,
        accentsKept,
        accentsDetected,
        meanPerceptualError: meanExtractionError,
        p95PerceptualError: p95ExtractionError,
      },
      preview: {
        changedVoxels,
        affectedVoxels: voxelCount,
        usedColors,
        preparedColors,
        toneOrderRetention,
        materialRamps,
        lightnessRange,
        minimumColorSeparation,
        candidateSwatches,
      },
      applied: {
        paletteColors: appliedSwatches.length,
        distinctPaletteSwatches: appliedShape.distinct,
        paletteSwatches: appliedSwatches,
      },
      httpRequestsAfterReferenceSelection: httpRequestsAfterReferenceSelection.length,
    };
    const referenceMetricsPath = testInfo.outputPath('rocket-reference-applied.metrics.json');
    await page.getByRole('button', { name: 'Close studio' }).click();
    await result.scrollIntoViewIfNeeded();
    const referenceScreenshotPath = testInfo.outputPath('rocket-reference-applied.png');
    const referenceScreenshot = await page.screenshot({ fullPage: true });

    // Persist all evidence together at the end so another Playwright run cannot
    // clean the output directory between the original and applied captures.
    writeFileSync(metricsPath, `${JSON.stringify(metrics, null, 2)}\n`);
    writeFileSync(screenshotPath, originalScreenshot);
    writeFileSync(referenceMetricsPath, `${JSON.stringify(referenceMetrics, null, 2)}\n`);
    writeFileSync(referenceScreenshotPath, referenceScreenshot);
    await testInfo.attach('rocket-conversion-metrics', { path: metricsPath, contentType: 'application/json' });
    await testInfo.attach('rocket-80x20', { path: screenshotPath, contentType: 'image/png' });
    await testInfo.attach('rocket-reference-applied-metrics', { path: referenceMetricsPath, contentType: 'application/json' });
    await testInfo.attach('rocket-reference-applied', { path: referenceScreenshotPath, contentType: 'image/png' });

    expect(browserErrors, 'conversion must not emit browser/runtime errors').toEqual([]);
  });
});
