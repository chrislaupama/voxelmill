# Release and operations

Every push and pull request runs unit tests, frontend and AI Worker TypeScript, both production bundles, explicit bundle ceilings, and Chromium editor smoke tests. Failed browser runs retain a short-lived trace/report artifact. A scheduled production check verifies `voxelmill.com`, its security headers, install manifest, and the unbilled AI health endpoint without uploading or processing any user models.

## Release checklist

1. Run `npm run check` and `npm run test:e2e`.
2. Run the private GLB identity gate with `VOXEL_TEST_ASSET_DIR` when the authorized corpus is present.
3. Run `VOXEL_TEST_ASSET_DIR=/path/to/asset-root npm run test:e2e:real-assets`, then review its rocket screenshot with the checklist in `docs/quality-baseline.md`.
4. Push `main`; the deploy job publishes the rate-limited `voxelmill-ai` Worker and then consumes the verified frontend artifact for Cloudflare Pages. `npm run deploy:all` is the manual recovery path.
5. Check `https://api.voxelmill.com/health`, the immutable Pages URL, `https://voxelmill.com/`, `www` redirect, manifest, service worker, MIME types, and security headers. Do not run real AI inference while the committed production kill switch is disabled.

Scheduled health checks provide operational coverage without application analytics or persisted Worker invocation logs. Palette Studio defaults to reference-image extraction entirely in the browser, which creates no network or AI request. Production AI is currently disabled. If deliberately enabled later, only the disclosed prompt, palette histogram, and lock flags leave the browser; raw network identifiers are not written to application, Durable Object, or log storage, while the binding retains only short-lived counters keyed by a rotating opaque digest. The Worker fails closed behind caller/edge limits, a global 100-attempt UTC-day ceiling, a kill switch, and a 20-second deadline. VoxelMill contains no model-upload endpoint or analytics SDK; GLBs, reference images, voxel geometry, coordinates, conversion, projects, autosaves, and diagnostics stay on the user's device.
