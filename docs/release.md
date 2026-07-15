# Release and operations

Every push and pull request runs unit tests, frontend and AI Worker TypeScript, both production bundles, explicit bundle ceilings, and Chromium editor smoke tests. Failed browser runs retain a short-lived trace/report artifact. A scheduled production check verifies `voxelmill.com`, its security headers, install manifest, and the unbilled AI health endpoint without uploading or processing any user models.

## Release checklist

1. Run `npm run check` and `npm run test:e2e`.
2. Run the private GLB identity gate with `VOXEL_TEST_ASSET_DIR` when the authorized corpus is present.
3. Verify the representative rocket visually: coherent geometry, stable regional colors, 96-color palette, and no browser errors.
4. Push `main`; the deploy job publishes the rate-limited `voxelmill-ai` Worker and then consumes the verified frontend artifact for Cloudflare Pages. `npm run deploy:all` is the manual recovery path.
5. Check `https://api.voxelmill.com/health`, the immutable Pages URL, `https://voxelmill.com/`, `www` redirect, manifest, service worker, MIME types, and security headers. A real palette generation is a manual release smoke because it invokes billed Workers AI inference.

Cloudflare request/error metrics and scheduled health checks provide operational coverage without application analytics. Palette Studio sends only an explicitly disclosed prompt, palette histogram, lock flags, and a stable random installation ID; Cloudflare also processes the network IP as a rate-limit backstop. VoxelMill contains no model-upload endpoint or analytics SDK; GLBs, voxel geometry, coordinates, conversion, projects, autosaves, and diagnostics stay on the user's device.
