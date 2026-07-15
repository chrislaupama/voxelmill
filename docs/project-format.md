# VoxelMill project format

`.voxelmill` is VoxelMill's local, versioned binary project container. Version 1 uses little-endian integers and is designed to preserve editable voxel data without embedding the original GLB.

## Layout

| Offset | Type | Meaning |
| ---: | --- | --- |
| 0 | 4 bytes | ASCII magic `VXMP` |
| 4 | uint16 | Format version (`1`) |
| 6 | uint32 | UTF-8 JSON manifest length |
| 10 | uint16 | Palette color count (1–255) |
| 12 | uint32 | Voxel count |
| 16 | bytes | Manifest, then palette, then voxel records |

The manifest stores the source display name, voxel size, grid dimensions, and conversion settings. Palette entries are three-byte RGB values. Each voxel record is seven bytes: unsigned 16-bit X, Y, and Z coordinates followed by an unsigned 8-bit palette index.

Readers must reject unsupported versions, trailing or truncated bytes, invalid dimensions, invalid options, out-of-range colors, coordinates outside the declared grid, palette indexes outside the palette, and duplicate voxel coordinates. VoxelMill applies all of these checks before replacing the current model.

Autosave stores the exact encoded project bytes in IndexedDB. This keeps browser recovery and downloaded project compatibility on the same tested code path while preserving VoxelMill's local-first privacy model.
