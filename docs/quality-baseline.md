# VoxelMill quality baseline

Baseline source revision: `18f5927`  
Captured: 2026-07-15

This baseline makes conversion quality and application weight testable before the production work changes either. User-supplied GLBs remain outside the repository; `quality/real-assets.json` records stable hashes and relative locations so the same inputs can be verified locally and in authorized CI environments.

## Current automated gates

Run all existing unit tests, the production build, and bundle budgets with:

```bash
npm run check
```

The production output is bounded by `quality/budgets.json`; budget changes must accompany a user-facing capability or a measured optimization:

| Resource | Baseline | Maximum |
| --- | ---: | ---: |
| Initial JavaScript | 1,175,034 B | 300,000 B |
| Initial JavaScript (gzip) | 327,579 B | 90,000 B |
| Total JavaScript | 1,175,034 B | 1,500,000 B |
| Total JavaScript (gzip) | 327,579 B | 410,000 B |
| Stylesheet | 17,387 B | 20,000 B |
| HTML document | 964 B | 2,000 B |

Budgets are ceilings, not targets. The 3D renderer and GLB loader are loaded on demand, reducing initial JavaScript to roughly 249 KB raw / 77 KB gzip while keeping total JavaScript separately bounded.

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

The next harness milestone must add synthetic textured GLBs with known expected colors, alpha behavior, UV transforms, and geometry. Real-asset runs then supplement those deterministic fixtures with screenshot and performance evidence.

## Known baseline constraints

- VOX dimensions are clamped to 255 cells per axis. There is no automatic scene chunking for larger exports.
- Resolution is limited to 24–128 and palette size to 8–255 in the current interface.
- The supplied Atlas weapon and pickup assets contain material colors but no embedded textures. The rocket is the principal high-poly texture regression input.

## Performance protocol

Browser benchmarks should record browser version, device, input hash, mode, resolution, palette size, alpha threshold, total duration, peak voxel count, output fingerprint, and palette/occupancy metrics. The benchmark is valid only when the UI remains responsive, progress is monotonic, cancellation completes promptly, and a repeated run produces the same fingerprint.

Development builds accept a `fixture` query parameter so browser automation can load a model through Vite's explicitly configured `VOXEL_TEST_ASSET_DIR` without exposing a production file-loading endpoint. This exercises the same `File` ingestion and background conversion path as manual selection.
