# VoxelMill command line exporter

The CLI turns a durable `.voxelmill` project into a MagicaVoxel scene, a full-color Qubicle Binary matrix, or readable JSON. GLB voxelization remains in the browser so texture decoding stays consistent with the verified web pipeline; save a project there, then automate downstream exports locally.

```bash
npm run cli -- model.voxelmill --format vox
npm run cli -- model.voxelmill --format qb --output builds/model.qb
npm run cli -- model.voxelmill --format json
```

The VOX exporter partitions models at 256-cell boundaries and writes a positioned VOX 150 scene graph, preventing byte-coordinate wrapping on large projects. QB stores each voxel's exact RGB value without reducing it to a shared palette.
