# Release and operations

Every push and pull request runs unit tests, TypeScript, the production build, explicit bundle ceilings, and Chromium editor smoke tests. Failed browser runs retain a short-lived trace/report artifact. A scheduled production check verifies `voxelmill.com`, its security headers, and install manifest without uploading or processing any user models.

## Release checklist

1. Run `npm run check` and `npm run test:e2e`.
2. Run the private GLB identity gate with `VOXEL_TEST_ASSET_DIR` when the authorized corpus is present.
3. Verify the representative rocket visually: coherent geometry, stable regional colors, 96-color palette, and no browser errors.
4. Deploy with `npm run deploy` only from a pushed, verified `main` commit.
5. Check the immutable Pages URL, `https://voxelmill.com/`, `www` redirect, manifest, service worker, MIME types, and security headers.

Cloudflare request/error metrics and the scheduled endpoint check provide operational health without application analytics. VoxelMill contains no model-upload endpoint, analytics SDK, or remote error payload; conversion, projects, autosaves, and diagnostics stay on the user's device.
