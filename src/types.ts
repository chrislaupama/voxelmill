import type { Group } from 'three';

export type FillMode = 'surface' | 'solid';
export type EditorTool = 'orbit' | 'add' | 'remove' | 'paint' | 'mirror';
export type MirrorAxis = 'x' | 'y' | 'z';
export type MirrorDirection = 'negativeToPositive' | 'positiveToNegative';

export interface VoxelCoordinate {
  x: number;
  y: number;
  z: number;
}

export interface MirrorSettings {
  axis: MirrorAxis;
  direction: MirrorDirection;
  plane: number;
}

export interface VoxelizeOptions {
  resolution: number;
  paletteSize: number;
  fillMode: FillMode;
  alphaThreshold: number;
}

export interface RGB {
  r: number;
  g: number;
  b: number;
}

export interface Voxel extends RGB {
  x: number;
  y: number;
  z: number;
  colorIndex: number;
}

export interface VoxelModel {
  voxels: Voxel[];
  palette: RGB[];
  size: { x: number; y: number; z: number };
  voxelSize: number;
  sourceName: string;
}

export interface SourceModel {
  scene: Group;
  name: string;
  bytes: number;
  triangles: number;
  meshes: number;
  materials: number;
  textures: number;
}

export interface ProgressUpdate {
  progress: number;
  label: string;
}
