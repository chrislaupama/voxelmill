# VoxelMill AI roadmap

VoxelMill should use AI where it adds artistic leverage while keeping geometry operations predictable. The guiding split is simple: hosted models propose compact creative intent; the browser performs voxel assignment, previews, edits, conversion, and exports deterministically.

## Phase 1 — Palette Studio foundation (implemented)

- Generate three named palette directions from a text prompt.
- Send only palette RGB values, usage counts, lock flags, and the prompt to the AI service.
- Preserve exact user-locked swatches.
- Recolor the whole model or only selected voxels.
- Offer tone-preserving and nearest-appearance mapping modes.
- Preview without changing autosave/history, then apply the exact preview as one undoable edit.
- Remap once per source palette index, never independently per voxel, preventing random color noise.
- Use a dedicated Cloudflare Worker with strict request/output validation and server-derived caller plus aggregate edge rate limits.
- Bound inference with a fail-closed global daily allowance, kill switch, and request deadline.

Release gate: the mocked browser flow, deterministic remap invariants, selection isolation, 255-color fallback, compact undo, Worker schema, origin, and rate-limit behavior must all pass.

## Phase 2 — Reference and semantic recoloring

Implemented:

- Local PNG/JPEG/WebP palette extraction with bounded decoding, alpha handling, OKLab clustering, neutral/accent preservation, diagnostics, and no network request.
- Deterministic body, trim, neutral, and energy-family mapping with monotonic shadow-to-highlight ramps.
- Readable-versus-exact palette controls, source-to-target inspection, changed-voxel counts, target coverage, separation metrics, and warnings before apply.

Remaining:

1. Add named material regions. Users select voxels and label them (for example `metal`, `energy`, `grip`, or `trim`); AI can propose a palette per named region while local selection boundaries remain authoritative.
2. Add explicit saturation, warmth, accent-percentage, and accessibility constraints rather than relying on prompt phrasing.
3. Add side-by-side saved palette variants and reusable palette presets.

Release gate: golden weapon/pickup fixtures must retain color boundaries and lightness ordering, and an unselected voxel must remain byte-for-byte unchanged.

## Phase 3 — Text/image-to-3D provider

The repository now contains provider-neutral job, state, repository, and artifact-store interfaces plus a disabled capability endpoint. Enabling generation requires a paid provider and durable infrastructure:

1. Configure a provider such as Meshy behind the Worker using a secret—not in browser code.
2. Run long jobs through Cloudflare Workflows, store normalized job state in D1, and copy completed GLBs immediately into private R2 because provider links expire.
3. Expose only opaque VoxelMill job IDs through create, status, refine, cancel, and artifact endpoints.
4. Add text-to-3D and reference-image-to-3D panels with explicit credit estimates and cancellation behavior.
5. Load the returned GLB into the existing local voxelizer, then open Palette Studio for final art direction.
6. Define retention and deletion controls for reference images, generated GLBs, and job metadata before accepting uploads.

Release gate: secrets never reach the browser, abandoned jobs stop polling, provider errors are normalized, artifacts survive expired provider URLs, deletion removes private inputs/artifacts, and spend limits are enforced.

## Phase 4 — Voxel-native generation research

- Fine-tune or condition a sparse 3D model on VoxelMill project data only when licensing and consent are explicit.
- Generate coarse occupancy and material regions, then use deterministic cleanup: connected-component filtering, symmetry, support checks, palette limits, and editor-ready layers.
- Prefer a hybrid workflow—AI blockout followed by VoxelMill editing—until geometry consistency beats mesh-to-voxel conversion on the same prompts.

This phase should remain experimental until a benchmark demonstrates better silhouette quality, editability, latency, and cost than generating a GLB and passing it through the proven converter.

## Operational priorities

- Add account-based quotas before opening expensive 3D generation publicly.
- Keep invocation/application logs disabled by default; if operational logging is later required, perform a privacy review and never record prompts, palette values, source images, client identifiers, or model data.
- Keep real AI inference out of routine CI. Use injected fake providers for tests and one deliberate billed smoke per release.
- Track cost per successful applied palette/job, not merely requests.
- Maintain an offline/manual path for every AI-assisted operation.
