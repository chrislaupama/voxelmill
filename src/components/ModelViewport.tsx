import { Bounds, Grid, OrbitControls } from '@react-three/drei';
import { Canvas, type ThreeEvent, useThree } from '@react-three/fiber';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
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
  SourceModel,
  Voxel,
  VoxelCoordinate,
  VoxelModel,
} from '../types';
import type { PaletteRemapPlan } from '../lib/paletteRemap';
import { brushCoordinates, type MirrorPlan } from '../lib/editVoxels';
import { getExposedVoxels } from '../lib/exposedVoxels';
import { packVoxelCoordinate } from '../lib/voxelIndex';

interface Props {
  source: SourceModel | null;
  model: VoxelModel | null;
  mode: 'source' | 'voxel';
  showGrid: boolean;
  tool: EditorTool;
  mirrorSettings: MirrorSettings;
  mirrorPlan: MirrorPlan | null;
  selectedVoxels: Voxel[];
  palettePreview?: PaletteRemapPlan | null;
  slice: { enabled: boolean; axis: MirrorSettings['axis']; index: number };
  brushRadius: number;
  brushShape: 'sphere' | 'cube';
  onVoxelAction: (voxel: Voxel, normal: VoxelCoordinate, phase: 'start' | 'continue') => void;
  onVoxelActionEnd: () => void;
}

interface VoxelInstancesProps {
  voxels: Voxel[];
  size: VoxelModel['size'];
  geometry: BoxGeometry;
  palette: VoxelModel['palette'];
  palettePreview?: PaletteRemapPlan | null;
  interactive: boolean;
  onHover: (voxel: Voxel, normal: VoxelCoordinate) => void;
  onHoverEnd: () => void;
  continuous: boolean;
  onAction: (voxel: Voxel, normal: VoxelCoordinate, phase: 'start' | 'continue') => void;
  onActionEnd: () => void;
}

const faceNormal = (event: ThreeEvent<MouseEvent>): VoxelCoordinate => {
  const normal = event.face?.normal ?? new Vector3();
  return { x: Math.round(normal.x), y: Math.round(normal.y), z: Math.round(normal.z) };
};

function VoxelInstances({
  voxels,
  size,
  geometry,
  palette,
  palettePreview,
  interactive,
  onHover,
  onHoverEnd,
  continuous,
  onAction,
  onActionEnd,
}: VoxelInstancesProps) {
  const mesh = useRef<InstancedMesh>(null);
  const strokeActive = useRef(false);
  const activePointerId = useRef<number | null>(null);
  const lastAction = useRef<string | null>(null);
  const eventSource = useThree((state) => state.gl.domElement);
  const material = useMemo(
    () => new MeshStandardMaterial({ color: '#ffffff', roughness: 0.78, metalness: 0.02 }),
    [],
  );
  const helper = useMemo(() => new Object3D(), []);
  const workingColor = useMemo(() => new Color(), []);

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
    mesh.current.computeBoundingBox();
    mesh.current.computeBoundingSphere();
  }, [helper, size, voxels]);

  useLayoutEffect(() => {
    if (!mesh.current || !voxels.length) return;
    if (!mesh.current.instanceColor) {
      workingColor.setRGB(1, 1, 1);
      mesh.current.setColorAt(0, workingColor);
    }
    const attribute = mesh.current.instanceColor;
    if (!attribute) return;
    const plan = palettePreview;
    voxels.forEach((voxel, index) => {
      const previewed = plan && (plan.scope === 'model'
        || plan.selection?.has(packVoxelCoordinate(voxel)));
      const previewIndex = previewed ? plan.colorIndexBySource.get(voxel.colorIndex) : undefined;
      const color = previewIndex === undefined ? palette[voxel.colorIndex] ?? voxel : plan?.palette[previewIndex] ?? voxel;
      workingColor.setRGB(color.r / 255, color.g / 255, color.b / 255, SRGBColorSpace);
      attribute.setXYZ(index, workingColor.r, workingColor.g, workingColor.b);
    });
    attribute.needsUpdate = true;
  }, [palette, palettePreview, voxels, workingColor]);

  const voxelFromEvent = (event: ThreeEvent<MouseEvent>) =>
    event.instanceId === undefined ? undefined : voxels[event.instanceId];

  const actionKey = (voxel: Voxel, normal: VoxelCoordinate) =>
    `${voxel.x}:${voxel.y}:${voxel.z}:${normal.x}:${normal.y}:${normal.z}`;

  const finishAction = useCallback((pointerId?: number) => {
    if (pointerId !== undefined && activePointerId.current !== pointerId) return;
    if (!strokeActive.current) return;
    strokeActive.current = false;
    activePointerId.current = null;
    lastAction.current = null;
    onActionEnd();
  }, [onActionEnd]);

  useEffect(() => {
    const finishCapturedAction = (event: PointerEvent) => finishAction(event.pointerId);
    eventSource.addEventListener('pointerup', finishCapturedAction);
    eventSource.addEventListener('pointercancel', finishCapturedAction);
    eventSource.addEventListener('lostpointercapture', finishCapturedAction);
    return () => {
      eventSource.removeEventListener('pointerup', finishCapturedAction);
      eventSource.removeEventListener('pointercancel', finishCapturedAction);
      eventSource.removeEventListener('lostpointercapture', finishCapturedAction);
    };
  }, [eventSource, finishAction]);

  return (
    <instancedMesh
      ref={mesh}
      args={[geometry, material, voxels.length]}
      onPointerMove={(event) => {
        if (!interactive) return;
        const voxel = voxelFromEvent(event);
        if (!voxel) return;
        event.stopPropagation();
        const normal = faceNormal(event);
        onHover(voxel, normal);
        if (!continuous || !strokeActive.current || !(event.buttons & 1)) return;
        const key = actionKey(voxel, normal);
        if (key === lastAction.current) return;
        lastAction.current = key;
        onAction(voxel, normal, 'continue');
      }}
      onPointerOut={() => {
        if (!interactive) return;
        onHoverEnd();
      }}
      onPointerDown={(event) => {
        if (!interactive || event.button !== 0) return;
        const voxel = voxelFromEvent(event);
        if (!voxel) return;
        event.stopPropagation();
        const captureTarget = event.target as Element;
        activePointerId.current = event.pointerId;
        captureTarget.setPointerCapture(event.pointerId);
        const normal = faceNormal(event);
        strokeActive.current = true;
        lastAction.current = actionKey(voxel, normal);
        onAction(voxel, normal, 'start');
      }}
      onPointerUp={(event) => {
        if (activePointerId.current !== event.pointerId) return;
        const captureTarget = event.target as Element;
        if (captureTarget.hasPointerCapture(event.pointerId)) {
          captureTarget.releasePointerCapture(event.pointerId);
        }
        finishAction(event.pointerId);
      }}
      onPointerCancel={(event) => finishAction(event.pointerId)}
      onLostPointerCapture={(event) => finishAction(event.pointerId)}
    />
  );
}

interface GhostVoxelsProps {
  voxels: Voxel[];
  size: VoxelModel['size'];
  color?: string;
  opacity?: number;
}

function GhostVoxels({ voxels, size, color = '#b5f43b', opacity = 0.26 }: GhostVoxelsProps) {
  const mesh = useRef<InstancedMesh>(null);
  const helper = useMemo(() => new Object3D(), []);
  const geometry = useMemo(() => new BoxGeometry(1.04, 1.04, 1.04), []);
  const material = useMemo(
    () => new MeshStandardMaterial({
      color,
      emissive: color,
      emissiveIntensity: 0.3,
      transparent: true,
      opacity,
      depthWrite: false,
      roughness: 0.65,
    }),
    [color, opacity],
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
    mesh.current.computeBoundingBox();
    mesh.current.computeBoundingSphere();
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
  mirrorPlan: MirrorPlan | null;
  selectedVoxels: Voxel[];
  palettePreview?: PaletteRemapPlan | null;
  slice: Props['slice'];
  brushRadius: number;
  brushShape: Props['brushShape'];
  onVoxelAction: Props['onVoxelAction'];
  onVoxelActionEnd: Props['onVoxelActionEnd'];
}

function VoxelMesh({ model, tool, mirrorSettings, mirrorPlan, selectedVoxels, palettePreview, slice, brushRadius, brushShape, onVoxelAction, onVoxelActionEnd }: VoxelMeshProps) {
  const [hovered, setHovered] = useState<VoxelCoordinate | null>(null);
  const geometry = useMemo(() => new BoxGeometry(0.94, 0.94, 0.94), []);
  const scale = 3.6 / Math.max(model.size.x, model.size.y, model.size.z);
  const interactive = tool !== 'orbit' && tool !== 'mirror';
  const visibleVoxels = useMemo(
    () => slice.enabled
      ? model.voxels.filter((voxel) => voxel[slice.axis] === slice.index)
      : getExposedVoxels(model.voxels),
    [model.voxels, slice.axis, slice.enabled, slice.index],
  );
  const visibleSelection = useMemo(
    () => {
      if (slice.enabled) return selectedVoxels.filter((voxel) => voxel[slice.axis] === slice.index);
      const selectedCoordinates = new Set(selectedVoxels.map(packVoxelCoordinate));
      return visibleVoxels.filter((voxel) => selectedCoordinates.has(packVoxelCoordinate(voxel)));
    },
    [selectedVoxels, slice.axis, slice.enabled, slice.index, visibleVoxels],
  );

  const updateHover = (voxel: Voxel, normal: VoxelCoordinate) => {
    setHovered(tool === 'add'
      ? { x: voxel.x + normal.x, y: voxel.y + normal.y, z: voxel.z + normal.z }
      : { x: voxel.x, y: voxel.y, z: voxel.z });
  };

  const hoverColor = tool === 'remove' ? '#ff625f' : tool === 'paint' || tool === 'fill' ? '#6dc8ff' : '#b5f43b';
  const hoverCoordinates = useMemo(() => {
    if (!hovered) return [];
    if (tool !== 'add' && tool !== 'remove' && tool !== 'paint') return [hovered];
    return brushCoordinates(
      hovered,
      brushRadius,
      tool === 'add' ? undefined : model.size,
      brushShape,
    );
  }, [brushRadius, brushShape, hovered, model.size, tool]);
  const hoverVoxels = useMemo(() => hoverCoordinates.map((coordinate) => ({
    ...coordinate,
    r: 255,
    g: 255,
    b: 255,
    colorIndex: 0,
  })), [hoverCoordinates]);

  return (
    <group scale={scale}>
      <VoxelInstances
        voxels={visibleVoxels}
        size={model.size}
        geometry={geometry}
        palette={model.palette}
        palettePreview={palettePreview}
        interactive={interactive}
        continuous={tool === 'select' || tool === 'add' || tool === 'remove' || tool === 'paint'}
        onHover={updateHover}
        onHoverEnd={() => setHovered(null)}
        onAction={onVoxelAction}
        onActionEnd={onVoxelActionEnd}
      />
      {hoverVoxels.length && interactive ? <GhostVoxels voxels={hoverVoxels} size={model.size} color={hoverColor} opacity={0.28} /> : null}
      {tool === 'mirror' ? (
        <>
          <MirrorPlane size={model.size} settings={mirrorSettings} />
          {mirrorPlan?.removals.length ? <GhostVoxels voxels={mirrorPlan.removals} size={model.size} color="#ff625f" opacity={0.34} /> : null}
          {mirrorPlan?.overwrites.length ? <GhostVoxels voxels={mirrorPlan.overwrites} size={model.size} color="#ffb84d" opacity={0.42} /> : null}
          {mirrorPlan?.additions.length ? <GhostVoxels voxels={mirrorPlan.additions} size={model.size} color="#b5f43b" opacity={0.34} /> : null}
        </>
      ) : null}
      {visibleSelection.length ? <GhostVoxels voxels={visibleSelection} size={model.size} color="#75c9ff" opacity={0.38} /> : null}
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
  mirrorPlan,
  selectedVoxels,
  palettePreview,
  slice,
  brushRadius,
  brushShape,
  onVoxelAction,
  onVoxelActionEnd,
}: Props) {
  return (
    <Canvas
      aria-label={mode === 'voxel' ? 'Interactive voxel model preview' : 'Interactive source model preview'}
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
            mirrorPlan={mirrorPlan}
            selectedVoxels={selectedVoxels}
            palettePreview={palettePreview}
            slice={slice}
            brushRadius={brushRadius}
            brushShape={brushShape}
            onVoxelAction={onVoxelAction}
            onVoxelActionEnd={onVoxelActionEnd}
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
      <OrbitControls makeDefault enabled={mode !== 'voxel' || tool === 'orbit' || tool === 'mirror'} enableDamping dampingFactor={0.08} minDistance={2.5} maxDistance={14} />
    </Canvas>
  );
}
