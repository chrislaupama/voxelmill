# VoxelMill quality baseline

Baseline established at source revision: `18f5927`
Current gate measured: 2026-07-20

This baseline makes conversion quality and application weight testable before the production work changes either. User-supplied GLBs remain outside the repository; `quality/real-assets.json` records stable hashes and relative locations so the same inputs can be verified locally and in authorized CI environments.

## Current automated gates

Run all existing unit tests, the production build, and bundle budgets with:

```bash
npm run check
```

The production output is bounded by `quality/budgets.json`; budget changes must accompany a user-facing capability or a measured optimization:

| Resource | Current measurement | Maximum |
| --- | ---: | ---: |
| Initial JavaScript | 274,891 B | 300,000 B |
| Initial JavaScript (gzip) | 84,920 B | 90,000 B |
| Total JavaScript | 1,512,576 B | 1,550,000 B |
| Total JavaScript (gzip) | 426,860 B | 435,000 B |
| Stylesheet | 28,715 B | 30,000 B |
| HTML document | 1,190 B | 2,000 B |

Budgets are ceilings, not targets. The 3D renderer, GLB loader, Palette Studio, VOX importer, and voxel GLB exporter are loaded on demand, keeping the initial application separately bounded.

Palette Studio is a measured 43,070 B lazy JavaScript chunk (14,020 B gzip), including the deterministic local reference-image extractor and the optional AI client. VOX import is 12,974 B lazy (5,009 B gzip), and game-engine GLB export is 6,396 B lazy (2,766 B gzip). These user-facing capabilities justify the narrow total and stylesheet ceiling increases; the initial bundle remains below its existing 300 KB / 90 KB gzip limits.

## Representative real assets

The private regression set spans three useful tiers:

| Tier | Representative asset | Triangles | Texture inputs | Purpose |
| --- | --- | ---: | ---: | --- |
| Small | Armor shard | 2,090 | 0 | Fast geometry smoke test |
| Medium | Plasma gun | 38,432 | 0 | Editing and material-color test |
| Large textured | Rocket | 396,204 | 4 | Texture sampling, palette fidelity, cancellation, and stress test |

Set `VOXEL_TEST_ASSET_DIR` to the directory containing the paths recorded in `quality/real-assets.json`. Validate or refresh metadata without copying the models into Git:

```bash
npm run inventory:glb -- "$VOXEL_TEST_ASSET_DIR/rocketl.glb"
```

## Conversion quality measures

`src/lib/quality.ts` establishes the first machine-readable vocabulary for regression tests:

- Palette error measures the nearest-palette OKLab distance for source samples. Gates can use mean, RMS, p95, and maximum error instead of subjective visual comparison alone.
- Occupancy precision, recall, and intersection-over-union compare generated geometry with a known voxel reference.
- A deterministic model fingerprint catches unintended changes to dimensions, palette, coordinates, or color assignment while ignoring voxel array order.

Synthetic pass/fail ceilings live in `quality/conversion-thresholds.json`. The ordered-band fixture is deliberately spatial: it fails if the correct palette colors are present but assigned as noise, as well as when palette reduction merges distinct source regions.

Color sampling stays in linear light from sRGB texel interpolation through per-cell triangle accumulation, and is encoded to sRGB only once when the raw voxel color is finalized. Triangle contributions are surface-area weighted to prevent dense tessellation from dominating an equally sized coarse surface. For solid models, propagated interior colors remain available for interior voxel assignment but do not vote in palette reduction; the visible shell therefore produces the same reduced palette in surface and solid modes. Focused unit fixtures gate all three invariants.

The next harness milestone should add generated textured GLBs with known alpha behavior and UV transforms. The authorized real-asset gate already supplements deterministic unit fixtures with screenshot, palette, geometry, duration, browser-error, and repeatability evidence.

## Known baseline constraints

- The shared editable/project/export coordinate contract is 0–1023 per axis. VOX export partitions larger models into translated scene nodes instead of clipping them to 255 cells, and VOX import composes supported scene transforms into one editable Y-up model.
- Resolution is limited to 24–128 and palette size to 8–255 in the current interface.
- VoxelMill projects and MagicaVoxel VOX files can be imported for editing. VOX, QB, voxel GLB, VoxelMill project, and palette PNG export are available; GLB export uses greedy meshing and physical voxel scale.
- The supplied Atlas weapon and pickup assets contain material colors but no embedded textures. The rocket is the principal high-poly texture regression input.

## Performance protocol

Browser benchmarks should record browser version, device, input hash, mode, resolution, palette size, alpha threshold, total duration, peak voxel count, output fingerprint, and palette/occupancy metrics. The benchmark is valid only when the UI remains responsive, progress is monotonic, cancellation completes promptly, and a repeated run produces the same fingerprint.

Development builds accept a `fixture` query parameter so browser automation can load a model through Vite's explicitly configured `VOXEL_TEST_ASSET_DIR` without exposing a production file-loading endpoint. This exercises the same `File` ingestion and background conversion path as manual selection.

Run the opt-in browser quality gate with the authorized asset root:

```bash
VOXEL_TEST_ASSET_DIR=/path/to/asset-root npm run test:e2e:real-assets
```

Without `VOXEL_TEST_ASSET_DIR`, the suite reports one skipped test and exits successfully. When configured, it first verifies the rocket's byte length and SHA-256 identity, then loads it through the development-only fixture path. The gate requires the default 80-cell resolution setting (reported dimensions include the converter's one-cell guard on each side), a 20-color result with 20 distinct swatches, valid occupancy, textured-source metadata, conversion duration, no UI error, and no browser, console, or failed-request errors. It then generates a deterministic 20-swatch material-reference PNG entirely in memory, extracts and applies that palette locally, checks its family, accent, tone-order, contrast, and mapping metrics, and fails if any HTTP(S) request occurs after image selection. Each successful run attaches separate original and reference-applied JSON metrics plus `rocket-80x20.png` and `rocket-reference-applied.png` under `test-results/real-assets`; neither the GLB nor generated image is copied into the repository.

WebGL pixel snapshots are retained as review evidence rather than compared byte-for-byte because browser, GPU, antialiasing, and Three.js rasterization differences make pixel baselines brittle. Review the screenshot and, when changing sampling or palette mapping, inspect the live model from the front, rear, both sides, top, and underside using this checklist:

1. The silhouette is recognizable, with no detached slabs, large unintended holes, or axis distortion.
2. Broad source-texture regions remain contiguous on the corresponding voxel surfaces; they do not become salt-and-pepper or rainbow noise.
3. Main body, metal/trim, shadow, and accent families remain spatially separated and preserve their relative lightness.
4. Isolated high-chroma voxels appear only where the source contains a matching detail, not across otherwise uniform panels.
5. Toggling Source and Voxel at the same camera angle confirms that major color boundaries land on the same physical parts.
6. A repeated run reports the same voxel count, dimensions, palette count, and distinct-swatch count.
