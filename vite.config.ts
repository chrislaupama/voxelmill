import { defineConfig, loadEnv, searchForWorkspaceRoot } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  const testAssetDirectory = loadEnv(mode, '.', 'VOXEL_').VOXEL_TEST_ASSET_DIR;
  return {
    plugins: [react()],
    server: {
      port: 4173,
      fs: {
        allow: [searchForWorkspaceRoot('.'), ...(testAssetDirectory ? [testAssetDirectory] : [])],
      },
    },
  };
});
