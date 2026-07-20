import {
  Box,
  Check,
  ChevronDown,
  CircleStop,
  Cuboid,
  Download,
  Eraser,
  FileBox,
  FlipHorizontal2,
  Grid3X3,
  Image as ImageIcon,
  Info,
  Layers3,
  LoaderCircle,
  MousePointer2,
  Pipette,
  PaintBucket,
  Palette,
  Plus,
  Redo2,
  RefreshCw,
  RotateCw,
  Save,
  Scan,
  SlidersHorizontal,
  Sparkles,
  Undo2,
  Upload,
} from 'lucide-react';
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  addVoxels,
  brushCoordinates,
  buildMirrorPlan,
  floodFillVoxels,
  paintVoxels,
  removeVoxels,
  rotateVoxels,
  translateVoxels,
  voxelLineCoordinates,
} from './lib/editVoxels';
import { decodeVoxelMillProject, downloadVoxelMillProject } from './lib/projectFormat';
import { loadAutosave, saveAutosave, type RecoveredProject } from './lib/projectStore';
import { compactPalette, replacePaletteColor, sortPalette } from './lib/paletteEditing';
import type { PaletteRemapPlan } from './lib/paletteRemap';
import { downloadQb } from './lib/qbExport';
import { applyVoxelPatch, createVoxelPatch, voxelPatchHasChanges, type VoxelPatch } from './lib/voxelHistory';
import { packVoxelCoordinate } from './lib/voxelIndex';
import {
  growSelection,
  invertSelection,
  selectConnected,
  selectSameColor,
  selectSlice,
  shrinkSelection,
} from './lib/voxelSelection';
import { isConversionCancelled, voxelizeGlbInWorker } from './lib/voxelizeWorker';
import { downloadVox } from './lib/voxExport';
import type {
  EditorTool,
  FillMode,
  MaterialColorMode,
  MirrorAxis,
  MirrorScope,
  MirrorSettings,
  ProgressUpdate,
  RGB,
  SamplingQuality,
  SourceModel,
  Voxel,
  VoxelCoordinate,
  VoxelModel,
  VoxelizeOptions,
} from './types';

const ModelViewport = lazy(() => import('./components/ModelViewport').then((module) => ({ default: module.ModelViewport })));
const AiPaletteStudio = lazy(() => import('./components/AiPaletteStudio').then((module) => ({ default: module.AiPaletteStudio })));

const DEFAULT_OPTIONS: VoxelizeOptions = {
  resolution: 80,
  paletteSize: 20,
  fillMode: 'solid',
  alphaThreshold: 0.1,
  samplingQuality: 'balanced',
  materialColorMode: 'baseColor',
};

const sameOptions = (left: VoxelizeOptions | null, right: VoxelizeOptions) => Boolean(left
  && left.resolution === right.resolution
  && left.paletteSize === right.paletteSize
  && left.fillMode === right.fillMode
  && left.alphaThreshold === right.alphaThreshold
  && left.samplingQuality === right.samplingQuality
  && left.materialColorMode === right.materialColorMode);

const formatBytes = (bytes: number) => {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
};

const rgbToHex = (color: RGB) =>
  `#${[color.r, color.g, color.b].map((channel) => channel.toString(16).padStart(2, '0')).join('')}`;

const hexToRgb = (value: string): RGB => ({
  r: Number.parseInt(value.slice(1, 3), 16),
  g: Number.parseInt(value.slice(3, 5), 16),
  b: Number.parseInt(value.slice(5, 7), 16),
});

const TOOL_LABELS: Record<EditorTool, string> = {
  orbit: 'Orbit',
  select: 'Select',
  add: 'Add voxel',
  remove: 'Erase voxel',
  paint: 'Paint voxel',
  fill: 'Flood fill',
  eyedropper: 'Pick color',
  mirror: 'Mirror',
};

const TOOL_INSTRUCTIONS: Record<Exclude<EditorTool, 'mirror'>, string> = {
  orbit: 'Choose an editing tool, then click directly on the model.',
  select: 'Click or drag across voxels to add or remove them from the current selection.',
  add: 'Click or drag across voxel faces to place voxels beside them.',
  remove: 'Click or drag across voxels to erase them with the current brush.',
  paint: 'Click or drag across voxels to recolor them with the current brush.',
  fill: 'Click a voxel to recolor its connected color region.',
  eyedropper: 'Click a voxel to make its color the active paint color.',
};

function downloadPalette(model: VoxelModel) {
  const cell = 40;
  const columns = Math.min(12, model.palette.length);
  const rows = Math.ceil(model.palette.length / columns);
  const canvas = document.createElement('canvas');
  canvas.width = columns * cell;
  canvas.height = rows * cell;
  const context = canvas.getContext('2d');
  if (!context) return;
  model.palette.forEach((color, index) => {
    context.fillStyle = `rgb(${color.r}, ${color.g}, ${color.b})`;
    context.fillRect((index % columns) * cell, Math.floor(index / columns) * cell, cell, cell);
  });
  const anchor = document.createElement('a');
  anchor.href = canvas.toDataURL('image/png');
  anchor.download = `${model.sourceName.replace(/\.[^.]+$/, '')}-palette.png`;
  anchor.click();
}

function App() {
  const inputRef = useRef<HTMLInputElement>(null);
  const sourceFileRef = useRef<File | null>(null);
  const conversionControllerRef = useRef<AbortController | null>(null);
  const developmentFixtureRef = useRef<string | null>(null);
  const autosaveGenerationRef = useRef(0);
  const voxelStrokeRef = useRef<{
    base: VoxelModel;
    current: VoxelModel;
    lastCenter: VoxelCoordinate | null;
  } | null>(null);
  const selectionStrokeRef = useRef<Set<number>>(new Set());
  const [source, setSource] = useState<SourceModel | null>(null);
  const [voxelModel, setVoxelModel] = useState<VoxelModel | null>(null);
  const [options, setOptions] = useState(DEFAULT_OPTIONS);
  const [builtOptions, setBuiltOptions] = useState<VoxelizeOptions | null>(null);
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);
  const [previewMode, setPreviewMode] = useState<'source' | 'voxel'>('source');
  const [showGrid, setShowGrid] = useState(true);
  const [busy, setBusy] = useState(false);
  const [canCancel, setCanCancel] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [progress, setProgress] = useState<ProgressUpdate>({ progress: 0, label: 'Waiting for a model' });
  const [error, setError] = useState<string | null>(null);
  const [recovery, setRecovery] = useState<RecoveredProject | null>(null);
  const [autosaveState, setAutosaveState] = useState<'idle' | 'saving' | 'saved' | 'unavailable'>('idle');
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [tool, setTool] = useState<EditorTool>('orbit');
  const [selectedColor, setSelectedColor] = useState<RGB>({ r: 181, g: 244, b: 59 });
  const [selectedPaletteIndex, setSelectedPaletteIndex] = useState<number | null>(null);
  const [customColor, setCustomColor] = useState('#b5f43b');
  const [customColorDraft, setCustomColorDraft] = useState('#b5f43b');
  const [brushRadius, setBrushRadius] = useState(0);
  const [brushShape, setBrushShape] = useState<'sphere' | 'cube'>('sphere');
  const [selection, setSelection] = useState<Set<number>>(() => new Set());
  const [slice, setSlice] = useState<{ enabled: boolean; axis: MirrorAxis; index: number }>({ enabled: false, axis: 'z', index: 0 });
  const [mirrorSettings, setMirrorSettings] = useState<MirrorSettings>({
    axis: 'x',
    direction: 'negativeToPositive',
    plane: 1,
  });
  const [mirrorScope, setMirrorScope] = useState<MirrorScope>('side');
  const [history, setHistory] = useState<{ past: VoxelPatch[]; future: VoxelPatch[] }>({ past: [], future: [] });
  const [aiStudioOpen, setAiStudioOpen] = useState(false);
  const [aiPreview, setAiPreview] = useState<{ base: VoxelModel; plan: PaletteRemapPlan } | null>(null);

  const selectedVoxels = useMemo(
    () => voxelModel ? voxelModel.voxels.filter((voxel) => selection.has(packVoxelCoordinate(voxel))) : [],
    [selection, voxelModel],
  );
  const mirrorPlan = useMemo(
    () => voxelModel && tool === 'mirror'
      ? buildMirrorPlan(voxelModel, mirrorSettings, selectedVoxels, mirrorScope)
      : null,
    [mirrorScope, mirrorSettings, selectedVoxels, tool, voxelModel],
  );
  const needsRebuild = Boolean(source && builtOptions && !sameOptions(builtOptions, options));

  const adoptVoxelModel = useCallback((result: VoxelModel, settings: VoxelizeOptions, dirty = false) => {
    setAiPreview(null);
    setVoxelModel(result);
    setBuiltOptions(settings);
    setHasUnsavedChanges(dirty);
    setHistory({ past: [], future: [] });
    setSelection(new Set());
    setTool('orbit');
    if (result.palette[0]) {
      setSelectedColor(result.palette[0]);
      setSelectedPaletteIndex(0);
      setCustomColor(rgbToHex(result.palette[0]));
      setCustomColorDraft(rgbToHex(result.palette[0]));
    }
    setMirrorSettings({
      axis: 'x',
      direction: 'negativeToPositive',
      plane: Math.max(1, Math.floor(result.size.x / 2)),
    });
    setMirrorScope('side');
    setSlice({ enabled: false, axis: 'z', index: Math.max(0, Math.floor(result.size.z / 2)) });
    setPreviewMode('voxel');
  }, []);

  const preserveCurrentBeforeReplacement = useCallback(async (message: string) => {
    if (!voxelModel || !hasUnsavedChanges) return true;
    if (!window.confirm(message)) return false;
    const savedAt = await saveAutosave({ model: voxelModel, options: builtOptions ?? options });
    if (savedAt !== null) {
      setAutosaveState('saved');
      setRecovery({ project: { model: voxelModel, options: builtOptions ?? options }, savedAt });
      return true;
    }
    return window.confirm('VoxelMill could not update local recovery storage. Continue and replace the current model anyway?');
  }, [builtOptions, hasUnsavedChanges, options, voxelModel]);

  const convert = useCallback(
    async (file: File, settings = options) => {
      conversionControllerRef.current?.abort();
      const controller = new AbortController();
      conversionControllerRef.current = controller;
      setBusy(true);
      setCanCancel(true);
      setError(null);
      setPreviewMode('source');
      try {
        const result = await voxelizeGlbInWorker(file, settings, setProgress, controller.signal);
        adoptVoxelModel(result, settings, true);
      } catch (conversionError) {
        if (isConversionCancelled(conversionError)) {
          setProgress({ progress: 0, label: 'Conversion cancelled' });
        } else {
          setError(conversionError instanceof Error ? conversionError.message : 'The model could not be converted.');
        }
      } finally {
        if (conversionControllerRef.current === controller) {
          conversionControllerRef.current = null;
          setCanCancel(false);
          setBusy(false);
        }
      }
    },
    [adoptVoxelModel, options],
  );

  const receiveFile = useCallback(
    async (file: File | undefined) => {
      if (!file || busy) return;
      const lowerName = file.name.toLowerCase();
      if (!lowerName.endsWith('.glb') && !lowerName.endsWith('.vox') && !lowerName.endsWith('.voxelmill')) {
        setError('Please choose a self-contained .glb, MagicaVoxel .vox, or .voxelmill project file.');
        return;
      }
      if (!await preserveCurrentBeforeReplacement('Replace the current model? VoxelMill will update local recovery first; download a project file for a portable copy.')) return;
      setBusy(true);
      setError(null);
      setProgress({
        progress: 0.02,
        label: lowerName.endsWith('.voxelmill')
          ? 'Opening VoxelMill project'
          : lowerName.endsWith('.vox')
            ? 'Opening MagicaVoxel model'
            : 'Opening GLB model',
      });
      try {
        if (lowerName.endsWith('.voxelmill')) {
          const project = decodeVoxelMillProject(await file.arrayBuffer());
          sourceFileRef.current = null;
          setSource(null);
          setOptions(project.options);
          adoptVoxelModel(project.model, project.options);
          setProgress({ progress: 1, label: 'VoxelMill project ready' });
          setBusy(false);
          return;
        }
        if (lowerName.endsWith('.vox')) {
          const { decodeVox } = await import('./lib/voxImport');
          const model = decodeVox(await file.arrayBuffer(), file.name);
          const importedOptions: VoxelizeOptions = {
            ...DEFAULT_OPTIONS,
            resolution: Math.max(24, Math.min(128, Math.max(model.size.x, model.size.y, model.size.z))),
            paletteSize: Math.max(8, Math.min(255, model.palette.length)),
          };
          sourceFileRef.current = null;
          setSource(null);
          setOptions(importedOptions);
          adoptVoxelModel(model, importedOptions);
          setProgress({ progress: 1, label: 'MagicaVoxel model ready' });
          setBusy(false);
          return;
        }
        const { loadGlb } = await import('./lib/modelLoader');
        const loaded = await loadGlb(file);
        sourceFileRef.current = file;
        setSource(loaded);
        setBusy(false);
        await convert(file);
      } catch (loadError) {
        setError(loadError instanceof Error ? loadError.message : 'The file could not be opened.');
        setBusy(false);
      }
    },
    [adoptVoxelModel, busy, convert, preserveCurrentBeforeReplacement],
  );

  useEffect(() => {
    let active = true;
    void loadAutosave().then((saved) => {
      if (active) setRecovery(saved);
    }).catch(() => {
      if (active) setAutosaveState('unavailable');
    });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!voxelModel) return;
    const generation = ++autosaveGenerationRef.current;
    const savedOptions = builtOptions ?? options;
    setAutosaveState('saving');
    const timer = window.setTimeout(() => {
      void saveAutosave({ model: voxelModel, options: savedOptions }).then((savedAt) => {
        if (autosaveGenerationRef.current !== generation) return;
        setAutosaveState(savedAt === null ? 'unavailable' : 'saved');
        if (savedAt !== null) setRecovery({ project: { model: voxelModel, options: savedOptions }, savedAt });
      }).catch(() => {
        if (autosaveGenerationRef.current === generation) setAutosaveState('unavailable');
      });
    }, 800);
    return () => window.clearTimeout(timer);
  }, [builtOptions, options, voxelModel]);

  useEffect(() => {
    if (!hasUnsavedChanges) return;
    const warnBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener('beforeunload', warnBeforeUnload);
    return () => window.removeEventListener('beforeunload', warnBeforeUnload);
  }, [hasUnsavedChanges]);

  const recoverAutosave = useCallback(() => {
    if (!recovery) return;
    sourceFileRef.current = null;
    setSource(null);
    setOptions(recovery.project.options);
    adoptVoxelModel(recovery.project.model, recovery.project.options, true);
    setError(null);
  }, [adoptVoxelModel, recovery]);

  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const fixture = new URLSearchParams(window.location.search).get('fixture');
    if (!fixture || developmentFixtureRef.current === fixture) return;
    developmentFixtureRef.current = fixture;
    void fetch(fixture).then(async (response) => {
      if (!response.ok) throw new Error(`Fixture request failed with HTTP ${response.status}.`);
      const blob = await response.blob();
      const name = decodeURIComponent(fixture.split('/').pop() || 'fixture.glb');
      await receiveFile(new File([blob], name, { type: 'model/gltf-binary' }));
    }).catch((fixtureError: unknown) => {
      setError(fixtureError instanceof Error ? fixtureError.message : 'The development fixture could not be loaded.');
    });
  }, [receiveFile]);

  useEffect(() => () => conversionControllerRef.current?.abort(), []);

  const updateOption = <K extends keyof VoxelizeOptions>(key: K, value: VoxelizeOptions[K]) => {
    setOptions((current) => ({ ...current, [key]: value }));
  };

  const clampEditorPlanes = useCallback((next: VoxelModel) => {
    setSlice((current) => ({
      ...current,
      index: Math.min(Math.max(0, next.size[current.axis] - 1), Math.max(0, current.index)),
    }));
    setMirrorSettings((current) => ({
      ...current,
      plane: Math.min(next.size[current.axis], Math.max(0, Math.round(current.plane))),
    }));
  }, []);

  const commitEdit = useCallback((next: VoxelModel) => {
    if (!voxelModel || next === voxelModel) return;
    const patch = createVoxelPatch(voxelModel, next);
    if (!voxelPatchHasChanges(patch)) return;
    setHistory((current) => ({ past: [...current.past, patch].slice(-100), future: [] }));
    setAiPreview(null);
    setVoxelModel(next);
    clampEditorPlanes(next);
    setHasUnsavedChanges(true);
  }, [clampEditorPlanes, voxelModel]);

  const undo = useCallback(() => {
    if (!voxelModel || !history.past.length) return;
    const patch = history.past[history.past.length - 1];
    setHistory({ past: history.past.slice(0, -1), future: [patch, ...history.future].slice(0, 100) });
    setAiPreview(null);
    const next = applyVoxelPatch(voxelModel, patch, 'undo');
    setVoxelModel(next);
    clampEditorPlanes(next);
    setSelection(new Set());
    setHasUnsavedChanges(true);
  }, [clampEditorPlanes, history, voxelModel]);

  const redo = useCallback(() => {
    if (!voxelModel || !history.future.length) return;
    const patch = history.future[0];
    setHistory({ past: [...history.past, patch].slice(-100), future: history.future.slice(1) });
    setAiPreview(null);
    const next = applyVoxelPatch(voxelModel, patch, 'redo');
    setVoxelModel(next);
    clampEditorPlanes(next);
    setSelection(new Set());
    setHasUnsavedChanges(true);
  }, [clampEditorPlanes, history, voxelModel]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target;
      if (target instanceof HTMLInputElement || target instanceof HTMLSelectElement || target instanceof HTMLTextAreaElement || (target instanceof HTMLElement && target.isContentEditable)) return;
      const key = event.key.toLowerCase();
      if (event.metaKey || event.ctrlKey) {
        if (key === 'z') {
          event.preventDefault();
          if (event.shiftKey) redo(); else undo();
        } else if (key === 'y') {
          event.preventDefault();
          redo();
        }
        return;
      }
      if (!voxelModel) return;
      const shortcutTools: Partial<Record<string, EditorTool>> = { q: 'orbit', s: 'select', a: 'add', e: 'remove', p: 'paint', f: 'fill', i: 'eyedropper', m: 'mirror' };
      const shortcutTool = shortcutTools[key];
      if (shortcutTool) {
        event.preventDefault();
        setPreviewMode('voxel');
        if (shortcutTool === 'mirror') setMirrorScope(selectedVoxels.length ? 'selection' : 'side');
        setTool(shortcutTool);
      } else if (key === 'g') {
        event.preventDefault();
        setShowGrid((value) => !value);
      } else if (key === '[' || key === ']') {
        event.preventDefault();
        setBrushRadius((value) => Math.max(0, Math.min(4, value + (key === '[' ? -1 : 1))));
      } else if ((key === 'delete' || key === 'backspace') && selectedVoxels.length) {
        event.preventDefault();
        commitEdit(removeVoxels(voxelModel, selectedVoxels));
        setSelection(new Set());
      } else if (key === 'escape') {
        setTool('orbit');
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [commitEdit, redo, selectedVoxels, undo, voxelModel]);

  const activateTool = (nextTool: EditorTool) => {
    if (!voxelModel) return;
    setPreviewMode('voxel');
    if (nextTool === 'mirror') setMirrorScope(selectedVoxels.length ? 'selection' : 'side');
    setTool(nextTool);
  };

  const handleVoxelAction = (voxel: Voxel, normal: VoxelCoordinate, phase: 'start' | 'continue') => {
    if (!voxelModel) return;
    if (tool === 'select') {
      const key = packVoxelCoordinate(voxel);
      if (phase === 'start') selectionStrokeRef.current.clear();
      if (selectionStrokeRef.current.has(key)) return;
      selectionStrokeRef.current.add(key);
      setSelection((current) => {
        const next = new Set(current);
        if (next.has(key)) next.delete(key); else next.add(key);
        return next;
      });
      return;
    }
    if (tool === 'eyedropper') {
      if (phase !== 'start') return;
      selectPaletteColor({ r: voxel.r, g: voxel.g, b: voxel.b }, voxel.colorIndex);
      return;
    }
    if (tool === 'fill') {
      if (phase !== 'start') return;
      commitEdit(floodFillVoxels(voxelModel, voxel, selectedColor));
      return;
    }
    if (tool !== 'add' && tool !== 'remove' && tool !== 'paint') return;
    if (phase === 'start' || !voxelStrokeRef.current) {
      voxelStrokeRef.current = { base: voxelModel, current: voxelModel, lastCenter: null };
    }
    const current = voxelStrokeRef.current.current;
    let next = current;
    const center = tool === 'add' ? {
      x: voxel.x + normal.x,
      y: voxel.y + normal.y,
      z: voxel.z + normal.z,
    } : { x: voxel.x, y: voxel.y, z: voxel.z };
    const centers = voxelStrokeRef.current.lastCenter
      ? voxelLineCoordinates(voxelStrokeRef.current.lastCenter, center)
      : [center];
    voxelStrokeRef.current.lastCenter = center;
    const coordinates = centers.flatMap((coordinate) => brushCoordinates(
      coordinate,
      brushRadius,
      tool === 'add' ? undefined : current.size,
      brushShape,
    ));
    if (tool === 'add') {
      const shift = coordinates.reduce((currentShift, coordinate) => ({
        x: Math.max(currentShift.x, -Math.min(0, coordinate.x)),
        y: Math.max(currentShift.y, -Math.min(0, coordinate.y)),
        z: Math.max(currentShift.z, -Math.min(0, coordinate.z)),
      }), { x: 0, y: 0, z: 0 });
      next = addVoxels(current, coordinates, selectedColor);
      if (next !== current && (shift.x || shift.y || shift.z)) {
        // addVoxels shifts the existing grid to keep coordinates non-negative.
        // Clear coordinate-keyed selection and shift the editor's grid planes too.
        setSelection(new Set());
        setSlice((currentSlice) => ({
          ...currentSlice,
          index: currentSlice.index + shift[currentSlice.axis],
        }));
        setMirrorSettings((currentMirror) => ({
          ...currentMirror,
          plane: currentMirror.plane + shift[currentMirror.axis],
        }));
        if (voxelStrokeRef.current?.lastCenter) {
          voxelStrokeRef.current.lastCenter = {
            x: voxelStrokeRef.current.lastCenter.x + shift.x,
            y: voxelStrokeRef.current.lastCenter.y + shift.y,
            z: voxelStrokeRef.current.lastCenter.z + shift.z,
          };
        }
      }
    } else if (tool === 'remove') {
      next = removeVoxels(current, coordinates);
      if (next !== current) {
        const removed = new Set(coordinates.map(packVoxelCoordinate));
        setSelection((currentSelection) => {
          if (![...removed].some((key) => currentSelection.has(key))) return currentSelection;
          return new Set([...currentSelection].filter((key) => !removed.has(key)));
        });
      }
    } else if (tool === 'paint') {
      next = paintVoxels(current, coordinates, selectedColor);
    }
    if (next !== current) {
      voxelStrokeRef.current.current = next;
      setAiPreview(null);
      setVoxelModel(next);
      setHasUnsavedChanges(true);
    }
  };

  const finishVoxelAction = () => {
    selectionStrokeRef.current.clear();
    const stroke = voxelStrokeRef.current;
    voxelStrokeRef.current = null;
    if (!stroke || stroke.current === stroke.base) return;
    const patch = createVoxelPatch(stroke.base, stroke.current);
    if (!voxelPatchHasChanges(patch)) return;
    setHistory((current) => ({ past: [...current.past, patch].slice(-100), future: [] }));
    setHasUnsavedChanges(true);
  };

  const selectPaletteColor = (color: RGB, index: number | null = null) => {
    setSelectedColor(color);
    setSelectedPaletteIndex(index);
    setCustomColor(rgbToHex(color));
    setCustomColorDraft(rgbToHex(color));
    if (tool === 'orbit' || tool === 'mirror' || tool === 'eyedropper') activateTool('paint');
  };

  const transformSelection = (operation: 'rotate' | VoxelCoordinate, axis: MirrorAxis = 'z') => {
    if (!voxelModel || !selectedVoxels.length) return;
    const result = operation === 'rotate'
      ? rotateVoxels(voxelModel, selectedVoxels, axis)
      : translateVoxels(voxelModel, selectedVoxels, operation);
    commitEdit(result.model);
    setSelection(new Set(result.coordinates.map(packVoxelCoordinate)));
  };

  const setMirrorAxis = (axis: MirrorAxis) => {
    if (!voxelModel) return;
    setMirrorSettings((current) => ({
      ...current,
      axis,
      plane: Math.max(1, Math.floor(voxelModel.size[axis] / 2)),
    }));
  };

  const previewAiPalette = useCallback((base: VoxelModel, preview: PaletteRemapPlan | null) => {
    setPreviewMode('voxel');
    setTool('orbit');
    const visiblePreview = preview?.metrics.changedVoxels ? preview : null;
    setAiPreview((current) => visiblePreview ? { base, plan: visiblePreview } : current?.base === base ? null : current);
  }, []);

  const applyAiPalette = useCallback((base: VoxelModel, result: VoxelModel) => {
    if (voxelModel !== base) {
      setAiPreview(null);
      return false;
    }
    commitEdit(result);
    setSelectedPaletteIndex(null);
    return true;
  }, [commitEdit, voxelModel]);

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <div className="brand-mark" aria-hidden="true">
            <Cuboid size={20} strokeWidth={2.2} />
          </div>
          <div>
            <div className="brand-name">VOXELMILL</div>
            <div className="brand-subtitle">HIGH POLY → VOX</div>
          </div>
        </div>
        <div className="topbar-center">
          <span className="status-dot" />
          LOCAL PROCESSING
          <span className="privacy-copy">Your model never leaves this device</span>
        </div>
        <button className="header-button" type="button" onClick={() => inputRef.current?.click()} disabled={busy}>
          <Upload size={16} />
          Open file
        </button>
      </header>

      <main className="workspace">
        <section
          className={`stage ${dragging ? 'is-dragging' : ''}`}
          onDragOver={(event) => {
            event.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(event) => {
            event.preventDefault();
            setDragging(false);
            void receiveFile(event.dataTransfer.files[0]);
          }}
        >
          {source || voxelModel ? (
            <>
              <div className="stage-toolbar">
                <div className="segmented-control" aria-label="Preview mode">
                  <button
                    className={previewMode === 'source' ? 'active' : ''}
                    aria-pressed={previewMode === 'source'}
                    onClick={() => setPreviewMode('source')}
                    disabled={!source || Boolean(aiPreview)}
                    type="button"
                  >
                    <Box size={15} /> Original
                  </button>
                  <button
                    className={previewMode === 'voxel' ? 'active' : ''}
                    aria-pressed={previewMode === 'voxel'}
                    onClick={() => voxelModel && setPreviewMode('voxel')}
                    disabled={!voxelModel}
                    type="button"
                  >
                    <Grid3X3 size={15} /> Voxel
                  </button>
                </div>
                <button
                  className={`icon-toggle ${showGrid ? 'active' : ''}`}
                  aria-pressed={showGrid}
                  type="button"
                  onClick={() => setShowGrid((value) => !value)}
                  title="Toggle grid"
                >
                  <Grid3X3 size={17} />
                </button>
              </div>
              {voxelModel && previewMode === 'voxel' && !aiPreview ? (
                <div className="editor-toolbar" aria-label="Voxel editing tools">
                  <div className="editor-tool-group">
                    <button className={tool === 'orbit' ? 'active' : ''} aria-pressed={tool === 'orbit'} aria-keyshortcuts="Q" type="button" onClick={() => activateTool('orbit')} title="Orbit (Q)">
                      <MousePointer2 size={16} /><span>Orbit</span>
                    </button>
                    <button className={tool === 'select' ? 'active blue' : ''} aria-pressed={tool === 'select'} aria-keyshortcuts="S" type="button" onClick={() => activateTool('select')} title="Select voxels (S)">
                      <Scan size={16} /><span>Select</span>
                    </button>
                    <button className={tool === 'add' ? 'active' : ''} aria-pressed={tool === 'add'} aria-keyshortcuts="A" type="button" onClick={() => activateTool('add')} title="Add voxel (A)">
                      <Plus size={16} /><span>Add</span>
                    </button>
                    <button className={tool === 'remove' ? 'active danger' : ''} aria-pressed={tool === 'remove'} aria-keyshortcuts="E" type="button" onClick={() => activateTool('remove')} title="Erase voxel (E)">
                      <Eraser size={16} /><span>Erase</span>
                    </button>
                    <button className={tool === 'paint' ? 'active blue' : ''} aria-pressed={tool === 'paint'} aria-keyshortcuts="P" type="button" onClick={() => activateTool('paint')} title="Paint voxel (P)">
                      <PaintBucket size={16} /><span>Paint</span>
                    </button>
                    <button className={tool === 'fill' ? 'active blue' : ''} aria-pressed={tool === 'fill'} aria-keyshortcuts="F" type="button" onClick={() => activateTool('fill')} title="Flood fill connected color (F)">
                      <PaintBucket size={16} /><span>Fill</span>
                    </button>
                    <button className={tool === 'eyedropper' ? 'active blue' : ''} aria-pressed={tool === 'eyedropper'} aria-keyshortcuts="I" type="button" onClick={() => activateTool('eyedropper')} title="Pick voxel color (I)">
                      <Pipette size={16} /><span>Pick</span>
                    </button>
                    <button className={tool === 'mirror' ? 'active' : ''} aria-pressed={tool === 'mirror'} aria-keyshortcuts="M" type="button" onClick={() => activateTool('mirror')} title="Mirror model (M)">
                      <FlipHorizontal2 size={16} /><span>Mirror</span>
                    </button>
                  </div>
                  <div className="editor-history-group">
                    <button type="button" onClick={undo} disabled={!history.past.length} title="Undo (⌘Z)"><Undo2 size={16} /></button>
                    <button type="button" onClick={redo} disabled={!history.future.length} title="Redo (⌘⇧Z)"><Redo2 size={16} /></button>
                  </div>
                </div>
              ) : null}
              <Suspense fallback={<div className="viewport-loading"><LoaderCircle className="spin" size={20} /> Loading 3D editor</div>}>
                <ModelViewport
                  source={source}
                  model={voxelModel}
                  mode={previewMode}
                  showGrid={showGrid}
                  tool={aiPreview ? 'orbit' : tool}
                  mirrorSettings={mirrorSettings}
                  mirrorPlan={aiPreview ? null : mirrorPlan}
                  selectedVoxels={aiPreview ? [] : selectedVoxels}
                  palettePreview={aiPreview?.plan}
                  slice={slice}
                  brushRadius={brushRadius}
                  brushShape={brushShape}
                  onVoxelAction={handleVoxelAction}
                  onVoxelActionEnd={finishVoxelAction}
                />
              </Suspense>
              <div className="view-hint">
                {aiPreview
                  ? 'PALETTE PREVIEW · CHOOSE CURRENT OR CANDIDATE IN THE STUDIO'
                  : previewMode === 'voxel' && tool !== 'orbit'
                  ? tool === 'mirror' ? 'GREEN ADDS · AMBER REPLACES · RED CLEARS · DRAG TO ORBIT' : `CLICK OR DRAG TO ${TOOL_LABELS[tool].toUpperCase()} · PRESS Q TO ORBIT`
                  : 'DRAG TO ORBIT · SCROLL TO ZOOM · RIGHT-DRAG TO PAN'}
              </div>
              {busy ? (
                <div className="processing-card" aria-live="polite">
                  <div className="processing-head">
                    <LoaderCircle className="spin" size={18} />
                    <span>{progress.label}</span>
                    <strong>{Math.round(progress.progress * 100)}%</strong>
                    {canCancel ? (
                      <button className="processing-cancel" type="button" onClick={() => conversionControllerRef.current?.abort()}>
                        <CircleStop size={14} /> Cancel
                      </button>
                    ) : null}
                  </div>
                  <div className="progress-track" role="progressbar" aria-label="Voxel conversion" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress.progress * 100)}>
                    <span style={{ width: `${progress.progress * 100}%` }} />
                  </div>
                </div>
              ) : null}
            </>
          ) : (
            <div className="empty-state">
              <div className="empty-visual" aria-hidden="true">
                <div className="voxel-cluster voxel-cluster-one" />
                <div className="voxel-cluster voxel-cluster-two" />
                <div className="voxel-cluster voxel-cluster-three" />
                <FileBox size={54} strokeWidth={1.35} />
              </div>
              <div className="eyebrow"><Sparkles size={13} /> TEXTURE-AWARE VOXELIZATION</div>
              <h1>Turn detailed models<br />into <em>voxel art.</em></h1>
              <p>
                Drop in a textured GLB. VoxelMill samples its materials, builds a compact palette,
                and exports a MagicaVoxel-ready file.
              </p>
              <button className="primary large" type="button" onClick={() => inputRef.current?.click()}>
                <Upload size={18} /> Open GLB, VOX, or project
              </button>
              {recovery ? (
                <button className="compact-upload" type="button" onClick={recoverAutosave}>
                  <RefreshCw size={16} /> Recover autosave from {new Date(recovery.savedAt).toLocaleString()}
                </button>
              ) : null}
              <span className="drop-copy">or drag and drop anywhere in this window</span>
              <div className="feature-row">
                <span><Check size={13} /> PBR base colors</span>
                <span><Check size={13} /> Embedded textures</span>
                <span><Check size={13} /> Up to 255 colors</span>
              </div>
            </div>
          )}
          {dragging ? (
            <div className="drop-overlay">
              <Upload size={38} />
              <strong>Drop GLB, VOX, or VoxelMill project</strong>
            </div>
          ) : null}
        </section>

        <aside className="inspector">
          <div className="inspector-scroll">
            <section className="panel-section source-section">
              <div className="section-label">SOURCE MODEL</div>
              {source ? (
                <div className="file-card">
                  <div className="file-icon"><FileBox size={21} /></div>
                  <div className="file-copy">
                    <strong title={source.name}>{source.name}</strong>
                    <span>{formatBytes(source.bytes)} · {source.triangles.toLocaleString()} triangles</span>
                  </div>
                  <button type="button" onClick={() => inputRef.current?.click()} disabled={busy} title="Replace model">
                    <RefreshCw size={15} />
                  </button>
                </div>
              ) : voxelModel ? (
                <div className="file-card">
                  <div className="file-icon"><Save size={21} /></div>
                  <div className="file-copy">
                    <strong title={voxelModel.sourceName}>{voxelModel.sourceName}</strong>
                    <span>{voxelModel.sourceName.toLowerCase().endsWith('.vox') ? 'MagicaVoxel model' : 'VoxelMill project'} · {voxelModel.voxels.length.toLocaleString()} voxels</span>
                  </div>
                  <button type="button" onClick={() => inputRef.current?.click()} disabled={busy} title="Open another file">
                    <RefreshCw size={15} />
                  </button>
                </div>
              ) : (
                <button className="compact-upload" type="button" onClick={() => inputRef.current?.click()}>
                  <Upload size={17} /> Select GLB, VOX, or project
                </button>
              )}
              {source ? (
                <div className="mini-stats">
                  <span><strong>{source.meshes}</strong> meshes</span>
                  <span><strong>{source.materials}</strong> materials</span>
                  <span><strong>{source.textures}</strong> textures</span>
                </div>
              ) : null}
            </section>

            <section className="panel-section">
              <div className="section-title">
                <div><SlidersHorizontal size={16} /> VOXEL SETTINGS</div>
                <span>{needsRebuild ? 'REBUILD NEEDED' : source ? 'CURRENT' : 'SOURCE REQUIRED'}</span>
              </div>
              <label className="control-label" htmlFor="resolution">
                <span>Resolution</span>
                <output>{options.resolution}<small> vox</small></output>
              </label>
              <input
                id="resolution"
                className="range"
                type="range"
                min="24"
                max="128"
                step="8"
                value={options.resolution}
                disabled={busy || !source}
                onChange={(event) => updateOption('resolution', Number(event.target.value))}
              />
              <div className="range-scale"><span>24</span><span>Balanced</span><span>128</span></div>
              <p className="control-help">Controls voxel count along the model’s longest side.</p>

              <label className="control-label palette-label" htmlFor="palette">
                <span>Palette size</span>
                <output>{options.paletteSize}<small> colors</small></output>
              </label>
              <input
                id="palette"
                className="range palette-range"
                type="range"
                min="8"
                max="255"
                step="1"
                value={options.paletteSize}
                disabled={busy || !source}
                onChange={(event) => updateOption('paletteSize', Number(event.target.value))}
              />
              <div className="range-scale"><span>8</span><span>Stylized</span><span>255</span></div>

              <div className="control-label fill-label"><span>Volume</span></div>
              <div className="choice-grid">
                {(['solid', 'surface'] as FillMode[]).map((mode) => (
                  <button
                    type="button"
                    key={mode}
                    className={options.fillMode === mode ? 'active' : ''}
                    onClick={() => updateOption('fillMode', mode)}
                    disabled={busy || !source}
                  >
                    {mode === 'solid' ? <Cuboid size={17} /> : <Layers3 size={17} />}
                    <span><strong>{mode === 'solid' ? 'Solid' : 'Surface'}</strong><small>{mode === 'solid' ? 'Fill interior' : 'Hollow shell'}</small></span>
                    {options.fillMode === mode ? <Check className="choice-check" size={13} /> : null}
                  </button>
                ))}
              </div>

              {needsRebuild ? <p className="control-help">Settings changed. Rebuild the voxel model to apply them.</p> : null}
              {!source && voxelModel ? <p className="control-help">Open the original GLB to rebuild this saved project with different settings.</p> : null}

              <button className="advanced-toggle" type="button" aria-expanded={advancedOpen} onClick={() => setAdvancedOpen((value) => !value)}>
                Advanced
                <ChevronDown className={advancedOpen ? 'rotated' : ''} size={15} />
              </button>
              {advancedOpen ? (
                <div className="advanced-control">
                  <label className="advanced-select-label" htmlFor="sampling-quality">
                    <span>Texture sampling</span>
                    <select
                      id="sampling-quality"
                      value={options.samplingQuality}
                      disabled={busy || !source}
                      onChange={(event) => updateOption('samplingQuality', event.target.value as SamplingQuality)}
                    >
                      <option value="draft">Draft</option>
                      <option value="balanced">Balanced</option>
                      <option value="high">High</option>
                    </select>
                  </label>
                  <label className="advanced-select-label" htmlFor="material-color-mode">
                    <span>Material color</span>
                    <select
                      id="material-color-mode"
                      value={options.materialColorMode}
                      disabled={busy || !source}
                      onChange={(event) => updateOption('materialColorMode', event.target.value as MaterialColorMode)}
                    >
                      <option value="baseColor">Base color</option>
                      <option value="appearance">Base + emissive</option>
                    </select>
                  </label>
                  <label className="control-label" htmlFor="alpha">
                    <span>Alpha cutoff</span>
                    <output>{Math.round(options.alphaThreshold * 100)}%</output>
                  </label>
                  <input
                    id="alpha"
                    className="range"
                    type="range"
                    min="0"
                    max="0.9"
                    step="0.05"
                    value={options.alphaThreshold}
                    disabled={busy || !source}
                    onChange={(event) => updateOption('alphaThreshold', Number(event.target.value))}
                  />
                </div>
              ) : null}
            </section>

            {voxelModel ? (
              <section className="panel-section ai-panel-section">
                <div className="section-title">
                  <div><Palette size={16} /> PALETTE STUDIO</div>
                  <span>LOCAL BY DEFAULT</span>
                </div>
                {!aiStudioOpen ? <p className="ai-panel-intro">Build a coherent palette from a reference image entirely on-device, or explicitly opt into AI art direction. Preview every mapping before applying it.</p> : null}
                <button
                  className={aiStudioOpen ? 'advanced-toggle ai-close-toggle' : 'compact-upload ai-open-button'}
                  type="button"
                  aria-expanded={aiStudioOpen}
                  aria-controls="palette-studio"
                  onClick={() => {
                    setAiStudioOpen((open) => !open);
                    setAiPreview(null);
                    setPreviewMode('voxel');
                    setTool('orbit');
                  }}
                >
                  {aiStudioOpen ? <>Close studio <ChevronDown className="rotated" size={15} /></> : <><Palette size={15} /> Open Palette Studio</>}
                </button>
                {aiStudioOpen ? (
                  <div id="palette-studio">
                    <Suspense fallback={<div className="ai-component-loading"><LoaderCircle className="spin" size={16} /> Loading Palette Studio…</div>}>
                      <AiPaletteStudio
                        model={voxelModel}
                        selection={selection}
                        selectedVoxelCount={selectedVoxels.length}
                        onPreview={previewAiPalette}
                        onApply={applyAiPalette}
                      />
                    </Suspense>
                  </div>
                ) : null}
              </section>
            ) : null}

            {voxelModel ? (
              <section className="panel-section editor-section">
                <div className="section-title">
                  <div><PaintBucket size={16} /> VOXEL EDITOR</div>
                  <span>{TOOL_LABELS[tool].toUpperCase()}</span>
                </div>

                {tool !== 'mirror' ? (
                  <>
                    <div className="editor-instruction">
                      {TOOL_INSTRUCTIONS[tool]}
                    </div>
                    {!voxelModel.voxels.length ? (
                      <button
                        className="primary empty-model-seed"
                        type="button"
                        onClick={() => {
                          commitEdit(addVoxels(voxelModel, [{ x: 0, y: 0, z: 0 }], selectedColor));
                          setTool('add');
                        }}
                      >
                        <Plus size={15} /> Place voxel at origin
                      </button>
                    ) : null}
                    {tool === 'select' ? (
                      <div className="editor-subsection">
                        <div className="control-label"><span>Selection</span><output>{selectedVoxels.length.toLocaleString()}</output></div>
                        <div className="compact-actions">
                          <button type="button" onClick={() => setSelection(slice.enabled
                            ? selectSlice(voxelModel, slice.axis, slice.index)
                            : new Set(voxelModel.voxels.map(packVoxelCoordinate)))}>{slice.enabled ? 'Select layer' : 'Select all'}</button>
                          <button type="button" onClick={() => setSelection(invertSelection(voxelModel, selection))}>Invert</button>
                          <button type="button" onClick={() => setSelection(new Set())} disabled={!selectedVoxels.length}>Clear</button>
                        </div>
                        <div className="compact-actions">
                          <button type="button" disabled={!selectedVoxels.length} onClick={() => selectedVoxels[0] && setSelection(selectConnected(voxelModel, selectedVoxels[0]))}>Connected</button>
                          <button type="button" disabled={!selectedVoxels.length} onClick={() => selectedVoxels[0] && setSelection(selectConnected(voxelModel, selectedVoxels[0], true))}>Connected color</button>
                          <button type="button" disabled={!selectedVoxels.length} onClick={() => selectedVoxels[0] && setSelection(selectSameColor(voxelModel, selectedVoxels[0]))}>Same color</button>
                        </div>
                        <div className="compact-actions">
                          <button type="button" disabled={!selectedVoxels.length} onClick={() => setSelection(growSelection(voxelModel, selection))}>Grow</button>
                          <button type="button" disabled={!selectedVoxels.length} onClick={() => setSelection(shrinkSelection(voxelModel, selection))}>Shrink</button>
                          <button type="button" disabled={!selectedVoxels.length} onClick={() => { commitEdit(removeVoxels(voxelModel, selectedVoxels)); setSelection(new Set()); }}>Delete</button>
                        </div>
                        <div className="control-label"><span>Move selection</span></div>
                        <div className="transform-grid">
                          {(['x', 'y', 'z'] as MirrorAxis[]).flatMap((axis) => [-1, 1].map((amount) => (
                            <button type="button" key={`${axis}-${amount}`} disabled={!selectedVoxels.length} onClick={() => transformSelection({ x: axis === 'x' ? amount : 0, y: axis === 'y' ? amount : 0, z: axis === 'z' ? amount : 0 })}>
                              {amount < 0 ? '−' : '+'}{axis.toUpperCase()}
                            </button>
                          )))}
                        </div>
                        <div className="control-label"><span>Rotate 90°</span></div>
                        <div className="axis-selector">
                          {(['x', 'y', 'z'] as MirrorAxis[]).map((axis) => <button type="button" key={axis} disabled={!selectedVoxels.length} onClick={() => transformSelection('rotate', axis)}><RotateCw size={12} /> {axis.toUpperCase()}</button>)}
                        </div>
                      </div>
                    ) : null}
                    {tool === 'add' || tool === 'remove' || tool === 'paint' ? (
                      <div className="editor-subsection">
                        <label className="control-label" htmlFor="brush-radius"><span>Brush radius</span><output>{brushRadius}</output></label>
                        <input id="brush-radius" className="range" type="range" min="0" max="4" step="1" value={brushRadius} onChange={(event) => setBrushRadius(Number(event.target.value))} />
                        <div className="axis-selector">
                          <button className={brushShape === 'sphere' ? 'active' : ''} type="button" onClick={() => setBrushShape('sphere')}>Sphere</button>
                          <button className={brushShape === 'cube' ? 'active' : ''} type="button" onClick={() => setBrushShape('cube')}>Cube</button>
                        </div>
                      </div>
                    ) : null}
                    {tool === 'add' || tool === 'paint' || tool === 'fill' || tool === 'eyedropper' ? (
                      <><div className="control-label editor-color-label">
                        <span>{tool === 'eyedropper' ? 'Picked color' : 'Paint color'}</span>
                        <output>{rgbToHex(selectedColor).toUpperCase()}</output>
                      </div>
                      <div className="palette-grid" aria-label="Voxel paint palette">
                        {voxelModel.palette.map((color, index) => {
                          const hex = rgbToHex(color);
                          const selected = color.r === selectedColor.r && color.g === selectedColor.g && color.b === selectedColor.b;
                          return (
                            <button
                              key={`${hex}-${index}`}
                              className={selected ? 'selected' : ''}
                              type="button"
                              aria-label={`Use palette color ${index + 1}: ${hex}`}
                              title={`${index + 1} · ${hex.toUpperCase()}`}
                              style={{ backgroundColor: hex }}
                              onClick={() => selectPaletteColor(color, index)}
                            />
                          );
                        })}
                      </div>
                      <div className="custom-color-row">
                      <label className="custom-color-chip" style={{ backgroundColor: customColor }}>
                        <input
                          type="color"
                          value={customColor}
                          aria-label="Choose custom voxel color"
                          onChange={(event) => {
                            setCustomColor(event.target.value);
                            setCustomColorDraft(event.target.value);
                            setSelectedColor(hexToRgb(event.target.value));
                          }}
                        />
                      </label>
                      <span><strong>Custom color</strong><small>Added to the palette when used</small></span>
                      <input
                        className="custom-hex-input"
                        type="text"
                        value={customColorDraft.toUpperCase()}
                        aria-label="Custom color hex"
                        maxLength={7}
                        spellCheck={false}
                        onChange={(event) => {
                          const value = event.target.value;
                          setCustomColorDraft(value);
                          if (/^#[0-9a-f]{6}$/i.test(value)) {
                            const normalized = value.toLowerCase();
                            setCustomColor(normalized);
                            setSelectedColor(hexToRgb(normalized));
                          }
                        }}
                      />
                      </div>
                      <div className="compact-actions palette-actions">
                        <button type="button" disabled={selectedPaletteIndex === null} onClick={() => {
                          if (selectedPaletteIndex === null) return;
                          commitEdit(replacePaletteColor(voxelModel, selectedPaletteIndex, selectedColor));
                        }}>Replace globally</button>
                        <button type="button" onClick={() => { commitEdit(compactPalette(voxelModel)); setSelectedPaletteIndex(null); }}>Remove unused</button>
                        <button type="button" onClick={() => { commitEdit(sortPalette(voxelModel, 'hue')); setSelectedPaletteIndex(null); }}>Sort by hue</button>
                        <button type="button" onClick={() => { commitEdit(sortPalette(voxelModel, 'luminance')); setSelectedPaletteIndex(null); }}>Sort by light</button>
                      </div></>
                    ) : null}

                    <div className="editor-subsection slice-controls">
                      <label className="slice-toggle"><input type="checkbox" checked={slice.enabled} onChange={(event) => setSlice((current) => ({ ...current, enabled: event.target.checked }))} /><span>Slice view</span></label>
                      {slice.enabled ? <>
                        <div className="axis-selector">
                          {(['x', 'y', 'z'] as MirrorAxis[]).map((axis) => <button className={slice.axis === axis ? 'active' : ''} type="button" key={axis} onClick={() => setSlice({ enabled: true, axis, index: Math.min(slice.index, voxelModel.size[axis] - 1) })}>{axis.toUpperCase()}</button>)}
                        </div>
                        <label className="control-label" htmlFor="slice-index"><span>Layer</span><output>{slice.index + 1} / {voxelModel.size[slice.axis]}</output></label>
                        <input id="slice-index" className="range" type="range" min="0" max={Math.max(0, voxelModel.size[slice.axis] - 1)} step="1" value={Math.min(slice.index, voxelModel.size[slice.axis] - 1)} onChange={(event) => setSlice((current) => ({ ...current, index: Number(event.target.value) }))} />
                      </> : null}
                    </div>
                  </>
                ) : (
                  <div className="mirror-controls">
                    <div className="mirror-preview-note">
                      <FlipHorizontal2 size={16} />
                      <span>
                        <strong>Live mirror preview</strong>
                        <small>{(mirrorPlan?.source.length ?? 0).toLocaleString()} source voxels · {((mirrorPlan?.additions.length ?? 0) + (mirrorPlan?.overwrites.length ?? 0)).toLocaleString()} destinations</small>
                      </span>
                    </div>
                    <div className="mirror-legend" aria-label="Mirror preview legend">
                      <span><i className="add" />{(mirrorPlan?.additions.length ?? 0).toLocaleString()} add</span>
                      <span><i className="overwrite" />{(mirrorPlan?.overwrites.length ?? 0).toLocaleString()} replace</span>
                      <span><i className="remove" />{(mirrorPlan?.removals.length ?? 0).toLocaleString()} clear</span>
                    </div>

                    <div className="control-label mirror-scope-label"><span>Mirror source</span></div>
                    <div className="mirror-scope-selector">
                      <button
                        className={mirrorScope === 'selection' ? 'active' : ''}
                        type="button"
                        disabled={!selectedVoxels.length}
                        onClick={() => setMirrorScope('selection')}
                      >
                        Selection <small>{selectedVoxels.length.toLocaleString()}</small>
                      </button>
                      <button className={mirrorScope === 'side' ? 'active' : ''} type="button" onClick={() => setMirrorScope('side')}>
                        Entire side
                      </button>
                    </div>

                    <div className="control-label mirror-axis-label"><span>Mirror axis</span></div>
                    <div className="axis-selector">
                      {(['x', 'y', 'z'] as MirrorAxis[]).map((axis) => (
                        <button className={mirrorSettings.axis === axis ? 'active' : ''} type="button" key={axis} onClick={() => setMirrorAxis(axis)}>
                          {axis.toUpperCase()}
                        </button>
                      ))}
                    </div>

                    {mirrorScope === 'side' ? <>
                      <div className="control-label mirror-direction-label"><span>Copy direction</span></div>
                      <div className="direction-selector">
                        <button
                          className={mirrorSettings.direction === 'negativeToPositive' ? 'active' : ''}
                          type="button"
                          onClick={() => setMirrorSettings((current) => ({ ...current, direction: 'negativeToPositive' }))}
                        >
                          <span>− {mirrorSettings.axis.toUpperCase()}</span><strong>→</strong><span>+ {mirrorSettings.axis.toUpperCase()}</span>
                        </button>
                        <button
                          className={mirrorSettings.direction === 'positiveToNegative' ? 'active' : ''}
                          type="button"
                          onClick={() => setMirrorSettings((current) => ({ ...current, direction: 'positiveToNegative' }))}
                        >
                          <span>+ {mirrorSettings.axis.toUpperCase()}</span><strong>→</strong><span>− {mirrorSettings.axis.toUpperCase()}</span>
                        </button>
                      </div>
                    </> : <p className="control-help mirror-selection-help">Only the selected voxels are copied. Everything else stays in place.</p>}

                    <label className="control-label mirror-plane-label" htmlFor="mirror-plane">
                      <span>Mirror plane</span>
                      <output>{mirrorSettings.axis.toUpperCase()} boundary {mirrorSettings.plane}</output>
                    </label>
                    <div className="mirror-plane-inputs">
                      <input
                        id="mirror-plane"
                        className="range mirror-range"
                        type="range"
                        min="0"
                        max={voxelModel.size[mirrorSettings.axis]}
                        step="1"
                        value={Math.min(voxelModel.size[mirrorSettings.axis], Math.max(0, mirrorSettings.plane))}
                        onChange={(event) => setMirrorSettings((current) => ({ ...current, plane: Math.round(Number(event.target.value)) }))}
                      />
                      <input
                        className="mirror-plane-number"
                        aria-label="Mirror plane boundary"
                        type="number"
                        min="0"
                        max={voxelModel.size[mirrorSettings.axis]}
                        step="1"
                        value={Math.min(voxelModel.size[mirrorSettings.axis], Math.max(0, mirrorSettings.plane))}
                        onChange={(event) => setMirrorSettings((current) => ({
                          ...current,
                          plane: Math.min(voxelModel.size[current.axis], Math.max(0, Math.round(Number(event.target.value)))),
                        }))}
                      />
                    </div>
                    <div className="range-scale"><span>0</span><span>Use slider or exact value</span><span>{voxelModel.size[mirrorSettings.axis]}</span></div>
                    <p className="control-help">
                      {mirrorScope === 'side'
                        ? 'The chosen source half is copied and unmatched voxels on the destination half are cleared.'
                        : 'The plane sits between voxel cells; edge values can mirror the selection beyond the current grid.'}
                    </p>
                    {mirrorPlan && (mirrorPlan.outputSize.x !== voxelModel.size.x || mirrorPlan.outputSize.y !== voxelModel.size.y || mirrorPlan.outputSize.z !== voxelModel.size.z) ? (
                      <p className="mirror-bounds-note">
                        Grid becomes {mirrorPlan.outputSize.x} × {mirrorPlan.outputSize.y} × {mirrorPlan.outputSize.z}
                        {mirrorPlan.shift.x || mirrorPlan.shift.y || mirrorPlan.shift.z
                          ? ` · existing voxels shift +${mirrorPlan.shift.x}, +${mirrorPlan.shift.y}, +${mirrorPlan.shift.z}`
                          : ''}
                      </p>
                    ) : null}
                    {mirrorPlan?.error ? <p className="mirror-error" role="alert">{mirrorPlan.error}</p> : null}

                    <div className="mirror-actions">
                      <button className="secondary-action" type="button" onClick={() => activateTool('orbit')}>Cancel</button>
                      <button
                        className="primary"
                        type="button"
                        disabled={!mirrorPlan?.valid || !(mirrorPlan.additions.length + mirrorPlan.overwrites.length + mirrorPlan.removals.length)}
                        onClick={() => {
                          if (!mirrorPlan?.valid) return;
                          commitEdit(mirrorPlan.model);
                          if (mirrorPlan.shift.x || mirrorPlan.shift.y || mirrorPlan.shift.z) {
                            setSlice((current) => ({
                              ...current,
                              index: Math.min(
                                Math.max(0, mirrorPlan.model.size[current.axis] - 1),
                                Math.max(0, current.index + mirrorPlan.shift[current.axis]),
                              ),
                            }));
                            setMirrorSettings((current) => ({
                              ...current,
                              plane: Math.min(
                                mirrorPlan.model.size[current.axis],
                                Math.max(0, current.plane + mirrorPlan.shift[current.axis]),
                              ),
                            }));
                          }
                          setSelection(mirrorScope === 'selection'
                            ? new Set(mirrorPlan.destinations.map(packVoxelCoordinate))
                            : new Set());
                          setTool('orbit');
                        }}
                      >
                        <FlipHorizontal2 size={15} /> Apply {((mirrorPlan?.additions.length ?? 0) + (mirrorPlan?.overwrites.length ?? 0) + (mirrorPlan?.removals.length ?? 0)).toLocaleString()} changes
                      </button>
                    </div>
                  </div>
                )}
              </section>
            ) : null}

            {voxelModel ? (
              <section className="panel-section result-section">
                <div className="section-title"><div><Sparkles size={16} /> RESULT</div></div>
                <div className="result-grid">
                  <div><span>Voxels</span><strong>{voxelModel.voxels.length.toLocaleString()}</strong></div>
                  <div><span>Dimensions</span><strong>{voxelModel.size.x} × {voxelModel.size.y} × {voxelModel.size.z}</strong></div>
                  <div><span>Palette</span><strong>{voxelModel.palette.length} colors</strong></div>
                </div>
                <div className="palette-strip" aria-label="Generated palette">
                  {voxelModel.palette.slice(0, 32).map((color, index) => (
                    <span key={index} style={{ background: `rgb(${color.r},${color.g},${color.b})` }} />
                  ))}
                </div>
              </section>
            ) : null}
          </div>

          <div className="inspector-footer">
            {error ? <div className="error-message" role="alert"><Info size={15} /><span>{error}</span><button type="button" onClick={() => setError(null)} aria-label="Dismiss error">×</button></div> : null}
            <button
              className="primary convert-button"
              type="button"
              disabled={!source || (busy && !canCancel)}
              onClick={() => {
                if (busy) conversionControllerRef.current?.abort();
                else if (sourceFileRef.current) {
                  const sourceFile = sourceFileRef.current;
                  void preserveCurrentBeforeReplacement('Rebuild and replace the current voxel model? VoxelMill will update local recovery first; download a project file for a portable copy.')
                    .then((canReplace) => {
                      if (canReplace) return convert(sourceFile, options);
                      return undefined;
                    });
                }
              }}
            >
              {busy ? canCancel ? <CircleStop size={17} /> : <LoaderCircle className="spin" size={17} /> : <Cuboid size={17} />}
              {busy ? canCancel ? 'Cancel conversion' : 'Opening model…' : voxelModel ? needsRebuild ? 'Apply settings & rebuild' : 'Rebuild voxel model' : 'Voxelize model'}
            </button>
            <div className="export-row">
              <button type="button" disabled={!voxelModel || busy} onClick={() => voxelModel && downloadVox(voxelModel)}>
                <Download size={16} /> .VOX
              </button>
              <button type="button" disabled={!voxelModel || busy} onClick={() => voxelModel && downloadQb(voxelModel)} title="Export full-color Qubicle Binary">
                <Download size={16} /> .QB
              </button>
              <button type="button" disabled={!voxelModel || busy} onClick={() => {
                if (!voxelModel) return;
                const model = voxelModel;
                setError(null);
                void import('./lib/glbExport')
                  .then(({ downloadGlb }) => downloadGlb(model))
                  .catch((exportError: unknown) => setError(exportError instanceof Error ? exportError.message : 'The GLB could not be exported.'));
              }} title="Export a game-engine-ready greedy-meshed voxel GLB">
                <Download size={16} /> .GLB
              </button>
              <button type="button" disabled={!voxelModel || busy} onClick={() => {
                if (!voxelModel) return;
                downloadVoxelMillProject({ model: voxelModel, options: builtOptions ?? options });
                setHasUnsavedChanges(false);
              }}>
                <Save size={16} /> Project
              </button>
              <button type="button" disabled={!voxelModel || busy} onClick={() => voxelModel && downloadPalette(voxelModel)} title="Export palette PNG">
                <ImageIcon size={16} /> Palette
              </button>
            </div>
            <div className="format-note"><Palette size={13} /> {autosaveState === 'saving' ? 'Saving locally…' : autosaveState === 'saved' ? hasUnsavedChanges ? 'Autosaved locally · project file not downloaded' : 'Project downloaded · autosaved locally' : autosaveState === 'unavailable' ? 'Autosave unavailable' : 'Local-first project storage'}</div>
          </div>
        </aside>
      </main>

      <input
        ref={inputRef}
        hidden
        type="file"
        accept=".glb,.vox,.voxelmill,model/gltf-binary,application/x-vox,application/x-voxelmill-project"
        onChange={(event) => {
          void receiveFile(event.target.files?.[0]);
          event.target.value = '';
        }}
      />
    </div>
  );
}

export default App;
