import { expect, test } from '@playwright/test';
import { encodeVoxelMillProject } from '../src/lib/projectFormat';
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
  await expect(page.getByRole('alert')).toContainText('self-contained .glb or .voxelmill');
  await expect(page.getByText('VOXEL EDITOR')).toBeVisible();
  await page.getByRole('button', { name: 'Dismiss error' }).click({ force: true });
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('publishes installable local-first metadata', async ({ page, request }) => {
  await page.goto('/');
  await expect(page.locator('link[rel=manifest]')).toHaveAttribute('href', '/manifest.webmanifest');
  const manifest = await request.get('/manifest.webmanifest');
  expect(manifest.ok()).toBe(true);
  expect((await manifest.json()).name).toBe('VoxelMill');
  expect(await page.locator('body').getAttribute('data-upload-endpoint')).toBeNull();
});
