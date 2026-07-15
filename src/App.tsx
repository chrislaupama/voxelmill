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
  buildMirrorPreview,
  floodFillVoxels,
  mirrorModel,
  paintVoxels,
  removeVoxels,
  rotateVoxels,
  translateVoxels,
} from './lib/editVoxels';
import { decodeVoxelMillProject, downloadVoxelMillProject } from './lib/projectFormat';
import { loadAutosave, saveAutosave, type RecoveredProject } from './lib/projectStore';
import { compactPalette, replacePaletteColor, sortPalette } from './lib/paletteEditing';
import type { PaletteRemapPlan } from './lib/paletteRemap';
import { downloadQb } from './lib/qbExport';
import { applyVoxelPatch, createVoxelPatch, voxelPatchHasChanges, type VoxelPatch } from './lib/voxelHistory';
import { packVoxelCoordinate } from './lib/voxelIndex';
import { isConversionCancelled, voxelizeGlbInWorker } from './lib/voxelizeWorker';
import { downloadVox } from './lib/voxExport';
import type {
  EditorTool,
  FillMode,
  MaterialColorMode,
  MirrorAxis,
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
  resolution: 64,
  paletteSize: 96,
  fillMode: 'solid',
  alphaThreshold: 0.1,
  samplingQuality: 'balanced',
  materialColorMode: 'baseColor',
};

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
  select: 'Click voxels to add or remove them from the current selection.',
  add: 'Click a voxel face to place voxels beside it.',
  remove: 'Click a voxel to erase it with the current brush.',
  paint: 'Click a voxel to recolor it with the current brush.',
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
  const [source, setSource] = useState<SourceModel | null>(null);
  const [voxelModel, setVoxelModel] = useState<VoxelModel | null>(null);
  const [options, setOptions] = useState(DEFAULT_OPTIONS);
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
  const [history, setHistory] = useState<{ past: VoxelPatch[]; future: VoxelPatch[] }>({ past: [], future: [] });
  const [aiStudioOpen, setAiStudioOpen] = useState(false);
  const [aiPreview, setAiPreview] = useState<{ base: VoxelModel; plan: PaletteRemapPlan } | null>(null);

  const mirrorPreview = useMemo(
    () => voxelModel && tool === 'mirror' ? buildMirrorPreview(voxelModel, mirrorSettings) : [],
    [mirrorSettings, tool, voxelModel],
  );
  const selectedVoxels = useMemo(
    () => voxelModel ? voxelModel.voxels.filter((voxel) => selection.has(packVoxelCoordinate(voxel))) : [],
    [selection, voxelModel],
  );

  const adoptVoxelModel = useCallback((result: VoxelModel) => {
    setAiPreview(null);
    setVoxelModel(result);
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
    setSlice({ enabled: false, axis: 'z', index: Math.max(0, Math.floor(result.size.z / 2)) });
    setPreviewMode('voxel');
  }, []);

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
        adoptVoxelModel(result);
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
      if (!lowerName.endsWith('.glb') && !lowerName.endsWith('.voxelmill')) {
        setError('Please choose a self-contained .glb or .voxelmill project file.');
        return;
      }
      setBusy(true);
      setError(null);
      setProgress({ progress: 0.02, label: lowerName.endsWith('.voxelmill') ? 'Opening VoxelMill project' : 'Opening GLB model' });
      try {
        if (lowerName.endsWith('.voxelmill')) {
          const project = decodeVoxelMillProject(await file.arrayBuffer());
          sourceFileRef.current = null;
          setSource(null);
          setOptions(project.options);
          adoptVoxelModel(project.model);
          setProgress({ progress: 1, label: 'VoxelMill project ready' });
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
    [adoptVoxelModel, busy, convert],
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
    setAutosaveState('saving');
    const timer = window.setTimeout(() => {
      void saveAutosave({ model: voxelModel, options }).then((savedAt) => {
        setAutosaveState(savedAt === null ? 'unavailable' : 'saved');
        if (savedAt !== null) setRecovery({ project: { model: voxelModel, options }, savedAt });
      }).catch(() => setAutosaveState('unavailable'));
    }, 800);
    return () => window.clearTimeout(timer);
  }, [options, voxelModel]);

  const recoverAutosave = useCallback(() => {
    if (!recovery) return;
    sourceFileRef.current = null;
    setSource(null);
    setOptions(recovery.project.options);
    adoptVoxelModel(recovery.project.model);
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

  const commitEdit = useCallback((next: VoxelModel) => {
    if (!voxelModel || next === voxelModel) return;
    const patch = createVoxelPatch(voxelModel, next);
    if (!voxelPatchHasChanges(patch)) return;
    setHistory((current) => ({ past: [...current.past, patch].slice(-100), future: [] }));
    setAiPreview(null);
    setVoxelModel(next);
  }, [voxelModel]);

  const undo = useCallback(() => {
    if (!voxelModel || !history.past.length) return;
    const patch = history.past[history.past.length - 1];
    setHistory({ past: history.past.slice(0, -1), future: [patch, ...history.future].slice(0, 100) });
    setAiPreview(null);
    setVoxelModel(applyVoxelPatch(voxelModel, patch, 'undo'));
    setSelection(new Set());
  }, [history, voxelModel]);

  const redo = useCallback(() => {
    if (!voxelModel || !history.future.length) return;
    const patch = history.future[0];
    setHistory({ past: [...history.past, patch].slice(-100), future: history.future.slice(1) });
    setAiPreview(null);
    setVoxelModel(applyVoxelPatch(voxelModel, patch, 'redo'));
    setSelection(new Set());
  }, [history, voxelModel]);

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
    setTool(nextTool);
  };

  const handleVoxelAction = (voxel: Voxel, normal: VoxelCoordinate) => {
    if (!voxelModel) return;
    if (tool === 'select') {
      const key = packVoxelCoordinate(voxel);
      setSelection((current) => {
        const next = new Set(current);
        if (next.has(key)) next.delete(key); else next.add(key);
        return next;
      });
      return;
    }
    if (tool === 'eyedropper') {
      selectPaletteColor({ r: voxel.r, g: voxel.g, b: voxel.b }, voxel.colorIndex);
      return;
    }
    if (tool === 'fill') {
      commitEdit(floodFillVoxels(voxelModel, voxel, selectedColor));
      return;
    }
    if (tool === 'add') {
      const target = {
        x: voxel.x + normal.x,
        y: voxel.y + normal.y,
        z: voxel.z + normal.z,
      };
      commitEdit(addVoxels(voxelModel, brushCoordinates(target, brushRadius, undefined, brushShape), selectedColor));
    } else if (tool === 'remove') {
      commitEdit(removeVoxels(voxelModel, brushCoordinates(voxel, brushRadius, voxelModel.size, brushShape)));
    } else if (tool === 'paint') {
      commitEdit(paintVoxels(voxelModel, brushCoordinates(voxel, brushRadius, voxelModel.size, brushShape), selectedColor));
    }
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
    setAiPreview((current) => preview ? { base, plan: preview } : current?.base === base ? null : current);
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
                  mirrorPreview={aiPreview ? [] : mirrorPreview}
                  selectedVoxels={aiPreview ? [] : selectedVoxels}
                  palettePreview={aiPreview?.plan}
                  slice={slice}
                  onVoxelAction={handleVoxelAction}
                />
              </Suspense>
              <div className="view-hint">
                {aiPreview
                  ? 'AI PALETTE PREVIEW · CHOOSE CURRENT OR CANDIDATE IN THE STUDIO'
                  : previewMode === 'voxel' && tool !== 'orbit'
                  ? tool === 'mirror' ? 'GHOST VOXELS SHOW THE MIRRORED RESULT · DRAG TO ORBIT' : `CLICK A VOXEL TO ${TOOL_LABELS[tool].toUpperCase()} · DRAG TO ORBIT`
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
                <Upload size={18} /> Open GLB or project
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
              <strong>Drop GLB or VoxelMill project</strong>
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
                    <span>VoxelMill project · {voxelModel.voxels.length.toLocaleString()} voxels</span>
                  </div>
                  <button type="button" onClick={() => inputRef.current?.click()} disabled={busy} title="Open another file">
                    <RefreshCw size={15} />
                  </button>
                </div>
              ) : (
                <button className="compact-upload" type="button" onClick={() => inputRef.current?.click()}>
                  <Upload size={17} /> Select GLB or project
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
                <span>LIVE</span>
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
                disabled={busy}
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
                disabled={busy}
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
                    disabled={busy}
                  >
                    {mode === 'solid' ? <Cuboid size={17} /> : <Layers3 size={17} />}
                    <span><strong>{mode === 'solid' ? 'Solid' : 'Surface'}</strong><small>{mode === 'solid' ? 'Fill interior' : 'Hollow shell'}</small></span>
                    {options.fillMode === mode ? <Check className="choice-check" size={13} /> : null}
                  </button>
                ))}
              </div>

              <button className="advanced-toggle" type="button" onClick={() => setAdvancedOpen((value) => !value)}>
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
                      disabled={busy}
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
                      disabled={busy}
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
                    disabled={busy}
                    onChange={(event) => updateOption('alphaThreshold', Number(event.target.value))}
                  />
                </div>
              ) : null}
            </section>

            {voxelModel ? (
              <section className="panel-section ai-panel-section">
                <div className="section-title">
                  <div><Sparkles size={16} /> AI PALETTE STUDIO</div>
                  <span>OPT-IN</span>
                </div>
                {!aiStudioOpen ? <p className="ai-panel-intro">Describe an art direction, compare three coherent palette concepts on the model, then apply one as a single undoable edit.</p> : null}
                <button
                  className={aiStudioOpen ? 'advanced-toggle ai-close-toggle' : 'compact-upload ai-open-button'}
                  type="button"
                  aria-expanded={aiStudioOpen}
                  aria-controls="ai-palette-studio"
                  onClick={() => {
                    setAiStudioOpen((open) => !open);
                    setAiPreview(null);
                    setPreviewMode('voxel');
                    setTool('orbit');
                  }}
                >
                  {aiStudioOpen ? <>Close studio <ChevronDown className="rotated" size={15} /></> : <><Sparkles size={15} /> Open AI Palette Studio</>}
                </button>
                {aiStudioOpen ? (
                  <div id="ai-palette-studio">
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
                    {tool === 'select' ? (
                      <div className="editor-subsection">
                        <div className="control-label"><span>Selection</span><output>{selectedVoxels.length.toLocaleString()}</output></div>
                        <div className="compact-actions">
                          <button type="button" onClick={() => setSelection(new Set(voxelModel.voxels.map(packVoxelCoordinate)))}>Select all</button>
                          <button type="button" onClick={() => setSelection(new Set())} disabled={!selectedVoxels.length}>Clear</button>
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
                      <span><strong>Live mirror preview</strong><small>{mirrorPreview.length.toLocaleString()} destination voxels shown in green</small></span>
                    </div>

                    <div className="control-label"><span>Mirror axis</span></div>
                    <div className="axis-selector">
                      {(['x', 'y', 'z'] as MirrorAxis[]).map((axis) => (
                        <button className={mirrorSettings.axis === axis ? 'active' : ''} type="button" key={axis} onClick={() => setMirrorAxis(axis)}>
                          {axis.toUpperCase()}
                        </button>
                      ))}
                    </div>

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

                    <label className="control-label mirror-plane-label" htmlFor="mirror-plane">
                      <span>Mirror plane</span>
                      <output>{mirrorSettings.axis.toUpperCase()} {mirrorSettings.plane}</output>
                    </label>
                    <input
                      id="mirror-plane"
                      className="range mirror-range"
                      type="range"
                      min="1"
                      max={Math.max(1, voxelModel.size[mirrorSettings.axis] - 1)}
                      step="1"
                      value={Math.min(mirrorSettings.plane, Math.max(1, voxelModel.size[mirrorSettings.axis] - 1))}
                      disabled={voxelModel.size[mirrorSettings.axis] <= 1}
                      onChange={(event) => setMirrorSettings((current) => ({ ...current, plane: Number(event.target.value) }))}
                    />
                    <div className="range-scale"><span>1</span><span>Drag the green plane</span><span>{Math.max(1, voxelModel.size[mirrorSettings.axis] - 1)}</span></div>
                    <p className="control-help">The destination side is replaced when you apply the mirror.</p>

                    <div className="mirror-actions">
                      <button className="secondary-action" type="button" onClick={() => activateTool('orbit')}>Cancel</button>
                      <button
                        className="primary"
                        type="button"
                        disabled={!mirrorPreview.length}
                        onClick={() => {
                          commitEdit(mirrorModel(voxelModel, mirrorSettings));
                          setTool('orbit');
                        }}
                      >
                        <FlipHorizontal2 size={15} /> Apply mirror
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
                else if (sourceFileRef.current) void convert(sourceFileRef.current);
              }}
            >
              {busy ? canCancel ? <CircleStop size={17} /> : <LoaderCircle className="spin" size={17} /> : <Cuboid size={17} />}
              {busy ? canCancel ? 'Cancel conversion' : 'Opening model…' : voxelModel ? 'Rebuild voxel model' : 'Voxelize model'}
            </button>
            <div className="export-row">
              <button type="button" disabled={!voxelModel || busy} onClick={() => voxelModel && downloadVox(voxelModel)}>
                <Download size={16} /> .VOX
              </button>
              <button type="button" disabled={!voxelModel || busy} onClick={() => voxelModel && downloadQb(voxelModel)} title="Export full-color Qubicle Binary">
                <Download size={16} /> .QB
              </button>
              <button type="button" disabled={!voxelModel || busy} onClick={() => voxelModel && downloadVoxelMillProject({ model: voxelModel, options })}>
                <Save size={16} /> Project
              </button>
              <button type="button" disabled={!voxelModel || busy} onClick={() => voxelModel && downloadPalette(voxelModel)} title="Export palette PNG">
                <ImageIcon size={16} /> Palette
              </button>
            </div>
            <div className="format-note"><Palette size={13} /> {autosaveState === 'saving' ? 'Saving locally…' : autosaveState === 'saved' ? 'Autosaved locally' : autosaveState === 'unavailable' ? 'Autosave unavailable' : 'Local-first project storage'}</div>
          </div>
        </aside>
      </main>

      <input
        ref={inputRef}
        hidden
        type="file"
        accept=".glb,.voxelmill,model/gltf-binary,application/x-voxelmill-project"
        onChange={(event) => {
          void receiveFile(event.target.files?.[0]);
          event.target.value = '';
        }}
      />
    </div>
  );
}

export default App;
