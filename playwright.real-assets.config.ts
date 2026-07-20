import { defineConfig, devices } from '@playwright/test';

const port = 4174;
const hasPrivateAssetRoot = Boolean(process.env.VOXEL_TEST_ASSET_DIR);

export default defineConfig({
  testDir: './e2e',
  testMatch: 'real-assets.spec.ts',
  fullyParallel: false,
  workers: 1,
  timeout: 300_000,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  reporter: 'list',
  outputDir: 'test-results/real-assets',
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: hasPrivateAssetRoot ? {
    // The private fixture hook is deliberately available only in Vite development.
    command: `npm run dev -- --host 127.0.0.1 --port ${port} --strictPort`,
    env: { ...process.env, VOXEL_REAL_ASSET_GATE: '1' },
    url: `http://127.0.0.1:${port}`,
    reuseExistingServer: false,
    timeout: 120_000,
  } : undefined,
});
