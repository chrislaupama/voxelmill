# VoxelMill

**High poly in. Voxels out.**

VoxelMill is a local-first browser application for converting textured GLB models into palette-based MagicaVoxel `.vox` files.

## What it does

- Loads self-contained `.glb` models in the browser.
- Intersects mesh triangles with a configurable voxel grid.
- Samples each material's base color and embedded base-color texture using interpolated UVs.
- Reduces sampled colors with weighted OKLab clustering to a configurable palette of up to 255 colors.
- Uses linear-light material blending, bilinear texel reads, and multi-point voxel coverage sampling.
- Produces either a hollow surface shell or a flood-filled solid volume.
- Previews the result with instanced Three.js geometry.
- Adds, erases, and paints voxels directly in the 3D viewport.
- Supports palette swatches, exact custom hex colors, and undo/redo history.
- Mirrors either side across a selectable X/Y/Z grid plane with a live ghost preview.
- Exports MagicaVoxel VOX 150 files and palette PNGs.

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

To inspect the structure and identity of private GLB regression assets without checking them into Git:

```bash
npm run inventory:glb -- /path/to/model.glb
```

## Deploy to Cloudflare Pages

```bash
npm run deploy
```

Production is hosted at [voxelmill.com](https://voxelmill.com/), with [voxelmill.pages.dev](https://voxelmill.pages.dev/) retained as the Cloudflare Pages address. The deployment configuration lives in `wrangler.jsonc`; static security headers are defined in `public/_headers`.

## Notes

The converter is intended for static or posed GLB assets. It bakes the current pose of skinned meshes. Very high resolutions and large triangle counts require more processing time because every triangle is tested against candidate voxel cells. The VOX exporter swaps the Three.js Y-up axis to MagicaVoxel's Z-up axis.
