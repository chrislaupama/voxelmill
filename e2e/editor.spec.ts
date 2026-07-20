import { expect, test } from '@playwright/test';
import { encodeVoxelMillProject } from '../src/lib/projectFormat';
import { encodeVox } from '../src/lib/voxExport';
import type { VoxelMillProject } from '../src/lib/projectFormat';

const fixture: VoxelMillProject = {
  options: { resolution: 32, paletteSize: 16, fillMode: 'solid', alphaThreshold: 0.1, samplingQuality: 'balanced', materialColorMode: 'baseColor' },
  model: {
    sourceName: 'e2e.glb', voxelSize: 1, size: { x: 3, y: 2, z: 1 },
    palette: [{ r: 210, g: 45, b: 35 }, { r: 30, g: 100, b: 220 }],
    voxels: [
      { x: 0, y: 0, z: 0, r: 210, g: 45, b: 35, colorIndex: 0 },
      { x: 1, y: 0, z: 0, r: 210, g: 45, b: 35, colorIndex: 0 },
      { x: 2, y: 1, z: 0, r: 30, g: 100, b: 220, colorIndex: 1 },
    ],
  },
};

async function openProject(page: import('@playwright/test').Page) {
  const bytes = encodeVoxelMillProject(fixture);
  await page.locator('input[type=file]').setInputFiles({
    name: 'e2e.voxelmill',
    mimeType: 'application/x-voxelmill-project',
    buffer: Buffer.from(bytes),
  });
  await expect(page.getByText('3', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('VOXEL EDITOR')).toBeVisible();
}

test('loads a project and exposes keyboard-accessible editing tools', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveTitle(/VoxelMill/);
  await expect(page.getByRole('button', { name: /Open file/i })).toBeVisible();
  await expect(page.getByLabel('Resolution')).toHaveValue('80');
  await expect(page.getByLabel('Palette size')).toHaveValue('20');
  await openProject(page);

  const select = page.getByRole('button', { name: 'Select voxels' });
  await select.click({ force: true });
  await expect(select).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('p');
  await expect(page.getByRole('button', { name: 'Paint voxel' })).toHaveAttribute('aria-pressed', 'true');

  await page.getByRole('checkbox', { name: 'Slice view' }).check();
  await expect(page.getByText(/Layer/)).toBeVisible();
  await expect(page.getByLabel('Interactive voxel model preview')).toBeVisible();
});

test('keeps an open project when a later file is rejected', async ({ page }) => {
  await page.goto('/');
  await openProject(page);
  await page.locator('input[type=file]').setInputFiles({ name: 'wrong.txt', mimeType: 'text/plain', buffer: Buffer.from('not a model') });
  await expect(page.getByRole('alert')).toContainText('self-contained .glb, MagicaVoxel .vox, or .voxelmill');
  await expect(page.getByText('VOXEL EDITOR')).toBeVisible();
  await page.getByRole('button', { name: 'Dismiss error' }).click({ force: true });
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('imports a MagicaVoxel file into the editable local workflow', async ({ page }) => {
  await page.goto('/');
  await page.locator('input[type=file]').setInputFiles({
    name: 'roundtrip.vox',
    mimeType: 'application/x-vox',
    buffer: Buffer.from(encodeVox(fixture.model)),
  });

  await expect(page.getByText('roundtrip.vox', { exact: true })).toBeVisible();
  await expect(page.getByText(/MagicaVoxel model · 3 voxels/u)).toBeVisible();
  await expect(page.getByText('VOXEL EDITOR')).toBeVisible();
  await expect(page.locator('.result-grid strong').nth(1)).toHaveText('3 × 2 × 1');
  await expect(page.locator('.result-grid strong').last()).toHaveText('2 colors');
  await expect(page.getByRole('button', { name: /\.GLB/u })).toBeEnabled();
});

test('publishes installable local-first metadata', async ({ page, request }) => {
  await page.goto('/');
  await expect(page.locator('link[rel=manifest]')).toHaveAttribute('href', '/manifest.webmanifest');
  const manifest = await request.get('/manifest.webmanifest');
  expect(manifest.ok()).toBe(true);
  expect((await manifest.json()).name).toBe('VoxelMill');
  expect(await page.locator('body').getAttribute('data-upload-endpoint')).toBeNull();
});

test('extracts and applies a reference image palette entirely on-device', async ({ page }) => {
  await page.goto('/');
  await openProject(page);
  const beforePalette = await page.locator('.palette-strip span').evaluateAll((swatches) => (
    swatches.map((swatch) => getComputedStyle(swatch).backgroundColor)
  ));
  await page.getByRole('button', { name: 'Open Palette Studio' }).click();
  await expect(page.getByRole('button', { name: /Reference image.*no AI.*no bill/i })).toHaveAttribute('aria-pressed', 'true');
  await page.waitForLoadState('networkidle');

  const networkRequests: string[] = [];
  page.on('request', (request) => {
    if (/^https?:/u.test(request.url())) networkRequests.push(`${request.method()} ${request.url()}`);
  });
  const pngBytes = await page.evaluate(async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 8;
    canvas.height = 8;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Canvas unavailable');
    const colors = ['#152113', '#687431', '#c28a2f', '#f1dfb3'];
    colors.forEach((color, index) => {
      context.fillStyle = color;
      context.fillRect((index % 2) * 4, Math.floor(index / 2) * 4, 4, 4);
    });
    const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((result) => (
      result ? resolve(result) : reject(new Error('PNG encoding failed'))
    ), 'image/png'));
    return [...new Uint8Array(await blob.arrayBuffer())];
  });
  await page.getByLabel('Reference image file').setInputFiles({
    name: 'olive-reference.png',
    mimeType: 'image/png',
    buffer: Buffer.from(pngBytes),
  });

  await expect(page.locator('.ai-candidates').getByText('Reference image', { exact: true })).toBeVisible();
  await expect(page.locator('.ai-candidate-strip i')).toHaveCount(4);
  await expect(page.getByLabel('Reference extraction diagnostics')).toContainText('4 swatches');
  await expect(page.getByText('pixels sampled')).toBeVisible();
  await expect(page.getByText(/decoded, downsampled and reduced to swatches entirely in this browser/i)).toBeVisible();
  await expect(page.getByText('voxels changed')).toBeVisible();
  await page.getByText('Inspect source → target mapping').click();
  await expect(page.locator('.ai-mapping-row')).toHaveCount(2);
  expect(networkRequests).toEqual([]);

  await page.getByRole('button', { name: 'Apply to model' }).click();
  const afterPalette = await page.locator('.palette-strip span').evaluateAll((swatches) => (
    swatches.map((swatch) => getComputedStyle(swatch).backgroundColor)
  ));
  expect(afterPalette).not.toEqual(beforePalette);
  expect(networkRequests).toEqual([]);
  await page.getByTitle(/Undo/).click();
  await expect.poll(async () => page.locator('.palette-strip span').evaluateAll((swatches) => (
    swatches.map((swatch) => getComputedStyle(swatch).backgroundColor)
  ))).toEqual(beforePalette);
});

test('previews, applies, and undoes an AI palette without uploading geometry', async ({ page }) => {
  let submitted: Record<string, unknown> | null = null;
  const fulfillPaletteRequest = async (route: import('@playwright/test').Route) => {
    submitted = JSON.parse(route.request().postData() ?? '{}') as Record<string, unknown>;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        version: 1,
        requestId: 'e2e-request',
        model: '@cf/e2e',
        suggestions: [
          { id: 'candidate-1', name: 'Arctic Alloy', description: 'Cold metal with a clean energy highlight.', colors: ['#07111f', '#244d70', '#73bddb', '#e5fbff'] },
          { id: 'candidate-2', name: 'Martian Oxide', description: 'Dark rust with a restrained hot accent.', colors: ['#1a0c09', '#74301f', '#c46a3b', '#ffd2a1'] },
          { id: 'candidate-3', name: 'Toxic Foundry', description: 'Industrial charcoal and acid green.', colors: ['#101310', '#354136', '#75a848', '#d9ff89'] },
        ],
      }),
    });
  };
  await page.route('**/api/ai/palette', fulfillPaletteRequest);
  await page.route('**/v1/palette', fulfillPaletteRequest);

  await page.goto('/');
  await openProject(page);
  const beforePalette = await page.locator('.palette-strip span').evaluateAll((swatches) => (
    swatches.map((swatch) => getComputedStyle(swatch).backgroundColor)
  ));
  await page.getByRole('button', { name: 'Open Palette Studio' }).click();
  await page.getByRole('button', { name: /Describe with AI.*incur AI usage/i }).click();
  await page.getByLabel('Describe the look').fill('cold arctic sci-fi metal');
  await page.getByRole('button', { name: 'Generate 3 palettes' }).click();

  await expect(page.getByText('Arctic Alloy', { exact: true })).toBeVisible();
  await expect(page.getByText('voxels changed')).toBeVisible();
  expect(submitted).toBeTruthy();
  expect(submitted).not.toHaveProperty('voxels');
  expect(submitted).not.toHaveProperty('sourceName');
  expect(JSON.stringify(submitted)).not.toMatch(/"x"|"y"|"z"/u);

  await page.getByRole('button', { name: 'Apply to model' }).click();
  await expect(page.locator('.result-grid strong').last()).toHaveText('2 colors');
  const appliedPalette = await page.locator('.palette-strip span').evaluateAll((swatches) => (
    swatches.map((swatch) => getComputedStyle(swatch).backgroundColor)
  ));
  expect(appliedPalette).not.toEqual(beforePalette);
  await page.getByTitle(/Undo/).click();
  await expect.poll(async () => page.locator('.palette-strip span').evaluateAll((swatches) => (
    swatches.map((swatch) => getComputedStyle(swatch).backgroundColor)
  ))).toEqual(beforePalette);
});
