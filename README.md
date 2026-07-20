# VoxelMill

**High poly in. Voxels out.**

VoxelMill is a local-first browser application for converting textured GLB models into palette-based MagicaVoxel `.vox` files.

## What it does

- Loads self-contained `.glb`, MagicaVoxel `.vox`, and VoxelMill project files in the browser.
- Intersects mesh triangles with a configurable voxel grid.
- Samples each material's base color and embedded base-color texture using interpolated UVs.
- Reduces sampled colors with weighted OKLab clustering to a configurable palette of up to 255 colors.
- Uses linear-light material blending, bilinear texel reads, and multi-point voxel coverage sampling.
- Runs conversion in a cancellable background worker with Draft, Balanced, and High sampling modes.
- Honors glTF material alpha cutoffs and can optionally bake emissive color/texture details.
- Produces either a hollow surface shell or a flood-filled solid volume.
- Previews the result with instanced Three.js geometry.
- Adds, erases, paints, flood-fills, selects, moves, and rotates voxels directly in the 3D viewport, including continuous brush strokes and slice editing.
- Supports palette swatches, exact custom hex colors, source/target mapping inspection, and undo/redo history.
- Defaults Palette Studio to local reference-image extraction: PNG, JPEG, and WebP images become structured 4–20-color palettes without an upload, AI request, or billable resource.
- Offers optional AI art direction behind an explicit source switch. The service receives only the prompt, swatches, lock flags, and color usage counts—never the GLB, reference image, voxel geometry, or coordinates.
- Mirrors a selection or an entire side across an exact X/Y/Z grid boundary with live add/replace/remove previews and safe grid expansion.
- Exports large positioned MagicaVoxel VOX 150 scenes, exact-color Qubicle Binary files, greedy-meshed voxel GLBs, VoxelMill projects, and palette PNGs.
- Saves compact, versioned `.voxelmill` project files that preserve conversion settings and editable voxel data.
- Autosaves project bytes and bounded deduplicated recovery snapshots to IndexedDB for local crash/reload recovery; model data is never uploaded.

## VoxelMill projects

The `.voxelmill` format is a versioned binary container with a validated manifest, RGB palette, and seven-byte voxel records. Open it through the same file picker used for GLBs. Autosaves use the identical encoder, so downloaded projects and browser recovery follow one compatibility path.

## Run locally

```bash
npm install
npm run dev
```

Then open `http://localhost:4173`.

## Production build

```bash
npm run check
```

This runs unit tests, creates the static output in `dist/`, and enforces the bundle budgets in `quality/budgets.json`. The full baseline and regression protocol are documented in `docs/quality-baseline.md`.

Browser release checks run with `npm run test:e2e`. The complete deployment checklist is in [docs/release.md](docs/release.md).

## Palette Studio and optional AI

The default Palette Studio path extracts a palette from a reference image entirely in the browser. Deterministic hue-family and material-ramp matching then maps source colors coherently instead of assigning colors independently per voxel. Users can inspect every source-to-target mapping, preview it on the model, and apply the exact preview as one undoable edit.

Optional AI palette generation is implemented behind a rate-limited Cloudflare Worker at `api.voxelmill.com`. AI requests contain the prompt, palette swatches, lock flags, and color usage counts. Reference images, GLBs, voxel geometry, and voxel coordinates remain in the browser.

The committed production configuration keeps AI inference disabled, so the current live app makes no billable Workers AI inference requests. The local reference-image workflow remains fully available. Before AI is deliberately enabled, the Worker requires a private HMAC secret and additional server-verified bot control; it then fails closed behind server-derived caller/edge limits, a global 100-attempt UTC-day ceiling, and a 20-second deadline. Worker invocation logs and traces are disabled.

The production API configuration is in `workers/ai-api/wrangler.jsonc`:

```bash
npm run build:api   # type-check and dry-run bundle
npm run deploy:api  # publish the API Worker
```

AI also requires an explicit `VITE_AI_PALETTE_ENABLED=true` frontend build. Leave it unset while production inference is paused.

No provider key is needed for Workers AI. Text/image-to-3D generation has a provider-neutral job contract but remains disabled until a paid generation provider and private artifact storage are configured. See [the AI roadmap](docs/ai-roadmap.md).

To inspect the structure and identity of private GLB regression assets without checking them into Git:

```bash
npm run inventory:glb -- /path/to/model.glb
```

When the full private regression corpus is available, verify every file against its recorded size and SHA-256 identity:

```bash
VOXEL_TEST_ASSET_DIR=/path/to/asset-root npm run check:assets
```

## Deploy to Cloudflare Pages

```bash
npm run deploy
```

Deploy both the AI Worker and Pages frontend with `npm run deploy:all`.

Production is hosted at [voxelmill.com](https://voxelmill.com/), with [voxelmill.pages.dev](https://voxelmill.pages.dev/) retained as the Cloudflare Pages address. The deployment configuration lives in `wrangler.jsonc`; static security headers are defined in `public/_headers`.

## Notes

The converter is intended for static or posed GLB assets. It bakes the current pose of skinned meshes. Very high resolutions and large triangle counts require more processing time because every triangle is tested against candidate voxel cells. The VOX exporter swaps the Three.js Y-up axis to MagicaVoxel's Z-up axis.

Saved projects can be exported without reopening the browser; see [the command-line guide](docs/cli.md).
