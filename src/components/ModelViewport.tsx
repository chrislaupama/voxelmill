import { Bounds, Grid, OrbitControls } from '@react-three/drei';
import { Canvas, type ThreeEvent } from '@react-three/fiber';
import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  BoxGeometry,
  Color,
  InstancedMesh,
  MeshStandardMaterial,
  Object3D,
  SRGBColorSpace,
  Vector3,
} from 'three';
import type {
  EditorTool,
  MirrorSettings,
  RGB,
  SourceModel,
  Voxel,
  VoxelCoordinate,
  VoxelModel,
} from '../types';

interface Props {
  source: SourceModel | null;
  model: VoxelModel | null;
  mode: 'source' | 'voxel';
  showGrid: boolean;
  tool: EditorTool;
  mirrorSettings: MirrorSettings;
  mirrorPreview: Voxel[];
  onVoxelAction: (voxel: Voxel, normal: VoxelCoordinate) => void;
}

interface ColorBatchProps {
  voxels: Voxel[];
  color: RGB;
  size: VoxelModel['size'];
  geometry: BoxGeometry;
  interactive: boolean;
  onHover: (voxel: Voxel, normal: VoxelCoordinate) => void;
  onHoverEnd: () => void;
  onAction: (voxel: Voxel, normal: VoxelCoordinate) => void;
}

const faceNormal = (event: ThreeEvent<MouseEvent>): VoxelCoordinate => {
  const normal = event.face?.normal ?? new Vector3();
  return { x: Math.round(normal.x), y: Math.round(normal.y), z: Math.round(normal.z) };
};

function ColorBatch({
  voxels,
  color,
  size,
  geometry,
  interactive,
  onHover,
  onHoverEnd,
  onAction,
}: ColorBatchProps) {
  const mesh = useRef<InstancedMesh>(null);
  const material = useMemo(
    () => {
      const materialColor = new Color().setRGB(color.r / 255, color.g / 255, color.b / 255, SRGBColorSpace);
      return new MeshStandardMaterial({ color: materialColor, roughness: 0.78, metalness: 0.02 });
    },
    [color.b, color.g, color.r],
  );
  const helper = useMemo(() => new Object3D(), []);

  useLayoutEffect(() => {
    if (!mesh.current) return;
    voxels.forEach((voxel, index) => {
      helper.position.set(
        voxel.x - (size.x - 1) / 2,
        voxel.y - (size.y - 1) / 2,
        voxel.z - (size.z - 1) / 2,
      );
      helper.updateMatrix();
      mesh.current!.setMatrixAt(index, helper.matrix);
    });
    mesh.current.instanceMatrix.needsUpdate = true;
  }, [helper, size, voxels]);

  const voxelFromEvent = (event: ThreeEvent<MouseEvent>) =>
    event.instanceId === undefined ? undefined : voxels[event.instanceId];

  return (
    <instancedMesh
      ref={mesh}
      args={[geometry, material, voxels.length]}
      onPointerMove={(event) => {
        if (!interactive) return;
        const voxel = voxelFromEvent(event);
        if (!voxel) return;
        event.stopPropagation();
        onHover(voxel, faceNormal(event));
      }}
      onPointerOut={() => interactive && onHoverEnd()}
      onClick={(event) => {
        if (!interactive) return;
        const voxel = voxelFromEvent(event);
        if (!voxel) return;
        event.stopPropagation();
        onAction(voxel, faceNormal(event));
      }}
    />
  );
}

interface GhostVoxelsProps {
  voxels: Voxel[];
  size: VoxelModel['size'];
}

function GhostVoxels({ voxels, size }: GhostVoxelsProps) {
  const mesh = useRef<InstancedMesh>(null);
  const helper = useMemo(() => new Object3D(), []);
  const geometry = useMemo(() => new BoxGeometry(1.04, 1.04, 1.04), []);
  const material = useMemo(
    () => new MeshStandardMaterial({
      color: '#b5f43b',
      emissive: '#5c8b13',
      emissiveIntensity: 0.3,
      transparent: true,
      opacity: 0.26,
      depthWrite: false,
      roughness: 0.65,
    }),
    [],
  );
  useLayoutEffect(() => {
    if (!mesh.current) return;
    voxels.forEach((voxel, index) => {
      helper.position.set(
        voxel.x - (size.x - 1) / 2,
        voxel.y - (size.y - 1) / 2,
        voxel.z - (size.z - 1) / 2,
      );
      helper.updateMatrix();
      mesh.current!.setMatrixAt(index, helper.matrix);
    });
    mesh.current.instanceMatrix.needsUpdate = true;
  }, [helper, size, voxels]);
  return <instancedMesh ref={mesh} args={[geometry, material, voxels.length]} raycast={() => null} />;
}

function MirrorPlane({ size, settings }: { size: VoxelModel['size']; settings: MirrorSettings }) {
  const dimensions: [number, number, number] = [size.x, size.y, size.z];
  const position: [number, number, number] = [0, 0, 0];
  const axisIndex = settings.axis === 'x' ? 0 : settings.axis === 'y' ? 1 : 2;
  dimensions[axisIndex] = 0.08;
  position[axisIndex] = settings.plane - size[settings.axis] / 2;
  return (
    <mesh position={position} raycast={() => null}>
      <boxGeometry args={dimensions} />
      <meshBasicMaterial color="#b5f43b" transparent opacity={0.18} depthWrite={false} />
    </mesh>
  );
}

interface VoxelMeshProps {
  model: VoxelModel;
  tool: EditorTool;
  mirrorSettings: MirrorSettings;
  mirrorPreview: Voxel[];
  onVoxelAction: Props['onVoxelAction'];
}

function VoxelMesh({ model, tool, mirrorSettings, mirrorPreview, onVoxelAction }: VoxelMeshProps) {
  const [hovered, setHovered] = useState<VoxelCoordinate | null>(null);
  const geometry = useMemo(() => new BoxGeometry(0.94, 0.94, 0.94), []);
  const batches = useMemo(() => {
    const grouped = model.palette.map(() => [] as Voxel[]);
    for (const voxel of model.voxels) grouped[voxel.colorIndex]?.push(voxel);
    return grouped;
  }, [model]);
  const scale = 3.6 / Math.max(model.size.x, model.size.y, model.size.z);
  const interactive = tool === 'add' || tool === 'remove' || tool === 'paint';

  const updateHover = (voxel: Voxel, normal: VoxelCoordinate) => {
    setHovered(tool === 'add'
      ? { x: voxel.x + normal.x, y: voxel.y + normal.y, z: voxel.z + normal.z }
      : { x: voxel.x, y: voxel.y, z: voxel.z });
  };

  const hoverColor = tool === 'remove' ? '#ff625f' : tool === 'paint' ? '#6dc8ff' : '#b5f43b';

  return (
    <group scale={scale}>
      {batches.map((voxels, colorIndex) =>
        voxels.length ? (
          <ColorBatch
            key={colorIndex}
            voxels={voxels}
            color={model.palette[colorIndex]}
            size={model.size}
            geometry={geometry}
            interactive={interactive}
            onHover={updateHover}
            onHoverEnd={() => setHovered(null)}
            onAction={onVoxelAction}
          />
        ) : null,
      )}
      {hovered && interactive ? (
        <mesh
          position={[
            hovered.x - (model.size.x - 1) / 2,
            hovered.y - (model.size.y - 1) / 2,
            hovered.z - (model.size.z - 1) / 2,
          ]}
          raycast={() => null}
        >
          <boxGeometry args={[1.06, 1.06, 1.06]} />
          <meshBasicMaterial color={hoverColor} wireframe transparent opacity={0.95} depthWrite={false} />
        </mesh>
      ) : null}
      {tool === 'mirror' ? (
        <>
          <MirrorPlane size={model.size} settings={mirrorSettings} />
          <GhostVoxels voxels={mirrorPreview} size={model.size} />
        </>
      ) : null}
    </group>
  );
}

function SourceMesh({ source }: { source: SourceModel }) {
  const clone = useMemo(() => source.scene.clone(true), [source]);
  return <primitive object={clone} />;
}

export function ModelViewport({
  source,
  model,
  mode,
  showGrid,
  tool,
  mirrorSettings,
  mirrorPreview,
  onVoxelAction,
}: Props) {
  return (
    <Canvas
      dpr={[1, 1.8]}
      camera={{ position: [4.6, 3.2, 4.8], fov: 38, near: 0.01, far: 1000 }}
      gl={{ antialias: true, alpha: true }}
      style={{ cursor: mode === 'voxel' && tool !== 'orbit' && tool !== 'mirror' ? 'crosshair' : 'grab' }}
      onCreated={({ gl }) => {
        gl.outputColorSpace = SRGBColorSpace;
      }}
    >
      <color attach="background" args={['#181b16']} />
      <ambientLight intensity={1.1} />
      <directionalLight position={[4, 8, 5]} intensity={3.2} color="#fff8df" />
      <directionalLight position={[-5, 2, -3]} intensity={1.8} color="#a9c8ff" />
      <Bounds key={`${mode}-${source?.name}`} fit clip observe margin={1.35}>
        {mode === 'source' && source ? <SourceMesh source={source} /> : null}
        {mode === 'voxel' && model ? (
          <VoxelMesh
            model={model}
            tool={tool}
            mirrorSettings={mirrorSettings}
            mirrorPreview={mirrorPreview}
            onVoxelAction={onVoxelAction}
          />
        ) : null}
      </Bounds>
      {showGrid ? (
        <Grid
          position={[0, -2.05, 0]}
          args={[12, 12]}
          cellSize={0.25}
          sectionSize={1}
          cellColor="#34392f"
          sectionColor="#59634f"
          fadeDistance={14}
          infiniteGrid
        />
      ) : null}
      <OrbitControls makeDefault enableDamping dampingFactor={0.08} minDistance={2.5} maxDistance={14} />
    </Canvas>
  );
}
