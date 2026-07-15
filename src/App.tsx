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
  PaintBucket,
  Palette,
  Plus,
  Redo2,
  RefreshCw,
  SlidersHorizontal,
  Sparkles,
  Undo2,
  Upload,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ModelViewport } from './components/ModelViewport';
import { addVoxel, buildMirrorPreview, mirrorModel, paintVoxel, removeVoxel } from './lib/editVoxels';
import { loadGlb } from './lib/modelLoader';
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
  add: 'Add voxel',
  remove: 'Erase voxel',
  paint: 'Paint voxel',
  mirror: 'Mirror',
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
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [tool, setTool] = useState<EditorTool>('orbit');
  const [selectedColor, setSelectedColor] = useState<RGB>({ r: 181, g: 244, b: 59 });
  const [customColor, setCustomColor] = useState('#b5f43b');
  const [customColorDraft, setCustomColorDraft] = useState('#b5f43b');
  const [mirrorSettings, setMirrorSettings] = useState<MirrorSettings>({
    axis: 'x',
    direction: 'negativeToPositive',
    plane: 1,
  });
  const [history, setHistory] = useState<{ past: VoxelModel[]; future: VoxelModel[] }>({ past: [], future: [] });

  const mirrorPreview = useMemo(
    () => voxelModel && tool === 'mirror' ? buildMirrorPreview(voxelModel, mirrorSettings) : [],
    [mirrorSettings, tool, voxelModel],
  );

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
        setVoxelModel(result);
        setHistory({ past: [], future: [] });
        setTool('orbit');
        if (result.palette[0]) {
          setSelectedColor(result.palette[0]);
          setCustomColor(rgbToHex(result.palette[0]));
          setCustomColorDraft(rgbToHex(result.palette[0]));
        }
        setMirrorSettings({
          axis: 'x',
          direction: 'negativeToPositive',
          plane: Math.max(1, Math.floor(result.size.x / 2)),
        });
        setPreviewMode('voxel');
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
    [options],
  );

  const receiveFile = useCallback(
    async (file: File | undefined) => {
      if (!file || busy) return;
      if (!file.name.toLowerCase().endsWith('.glb')) {
        setError('Please choose a self-contained .glb file.');
        return;
      }
      setBusy(true);
      setError(null);
      setVoxelModel(null);
      setHistory({ past: [], future: [] });
      setTool('orbit');
      setProgress({ progress: 0.02, label: 'Opening GLB model' });
      try {
        const loaded = await loadGlb(file);
        sourceFileRef.current = file;
        setSource(loaded);
        setBusy(false);
        await convert(file);
      } catch (loadError) {
        setError(loadError instanceof Error ? loadError.message : 'The GLB file could not be opened.');
        setBusy(false);
      }
    },
    [busy, convert],
  );

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
    setHistory((current) => ({ past: [...current.past, voxelModel].slice(-40), future: [] }));
    setVoxelModel(next);
  }, [voxelModel]);

  const undo = useCallback(() => {
    if (!voxelModel || !history.past.length) return;
    const previous = history.past[history.past.length - 1];
    setHistory({ past: history.past.slice(0, -1), future: [voxelModel, ...history.future].slice(0, 40) });
    setVoxelModel(previous);
  }, [history, voxelModel]);

  const redo = useCallback(() => {
    if (!voxelModel || !history.future.length) return;
    const next = history.future[0];
    setHistory({ past: [...history.past, voxelModel].slice(-40), future: history.future.slice(1) });
    setVoxelModel(next);
  }, [history, voxelModel]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey)) return;
      if (event.key.toLowerCase() === 'z') {
        event.preventDefault();
        if (event.shiftKey) redo(); else undo();
      } else if (event.key.toLowerCase() === 'y') {
        event.preventDefault();
        redo();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [redo, undo]);

  const activateTool = (nextTool: EditorTool) => {
    if (!voxelModel) return;
    setPreviewMode('voxel');
    setTool(nextTool);
  };

  const handleVoxelAction = (voxel: Voxel, normal: VoxelCoordinate) => {
    if (!voxelModel) return;
    if (tool === 'add') {
      commitEdit(addVoxel(voxelModel, {
        x: voxel.x + normal.x,
        y: voxel.y + normal.y,
        z: voxel.z + normal.z,
      }, selectedColor));
    } else if (tool === 'remove') {
      commitEdit(removeVoxel(voxelModel, voxel));
    } else if (tool === 'paint') {
      commitEdit(paintVoxel(voxelModel, voxel, selectedColor));
    }
  };

  const selectPaletteColor = (color: RGB) => {
    setSelectedColor(color);
    setCustomColor(rgbToHex(color));
    setCustomColorDraft(rgbToHex(color));
    if (tool === 'orbit' || tool === 'mirror') activateTool('paint');
  };

  const setMirrorAxis = (axis: MirrorAxis) => {
    if (!voxelModel) return;
    setMirrorSettings((current) => ({
      ...current,
      axis,
      plane: Math.max(1, Math.floor(voxelModel.size[axis] / 2)),
    }));
  };

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
          Open GLB
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
          {source ? (
            <>
              <div className="stage-toolbar">
                <div className="segmented-control" aria-label="Preview mode">
                  <button
                    className={previewMode === 'source' ? 'active' : ''}
                    onClick={() => setPreviewMode('source')}
                    type="button"
                  >
                    <Box size={15} /> Original
                  </button>
                  <button
                    className={previewMode === 'voxel' ? 'active' : ''}
                    onClick={() => voxelModel && setPreviewMode('voxel')}
                    disabled={!voxelModel}
                    type="button"
                  >
                    <Grid3X3 size={15} /> Voxel
                  </button>
                </div>
                <button
                  className={`icon-toggle ${showGrid ? 'active' : ''}`}
                  type="button"
                  onClick={() => setShowGrid((value) => !value)}
                  title="Toggle grid"
                >
                  <Grid3X3 size={17} />
                </button>
              </div>
              {voxelModel && previewMode === 'voxel' ? (
                <div className="editor-toolbar" aria-label="Voxel editing tools">
                  <div className="editor-tool-group">
                    <button className={tool === 'orbit' ? 'active' : ''} type="button" onClick={() => activateTool('orbit')} title="Orbit">
                      <MousePointer2 size={16} /><span>Orbit</span>
                    </button>
                    <button className={tool === 'add' ? 'active' : ''} type="button" onClick={() => activateTool('add')} title="Add voxel">
                      <Plus size={16} /><span>Add</span>
                    </button>
                    <button className={tool === 'remove' ? 'active danger' : ''} type="button" onClick={() => activateTool('remove')} title="Erase voxel">
                      <Eraser size={16} /><span>Erase</span>
                    </button>
                    <button className={tool === 'paint' ? 'active blue' : ''} type="button" onClick={() => activateTool('paint')} title="Paint voxel">
                      <PaintBucket size={16} /><span>Paint</span>
                    </button>
                    <button className={tool === 'mirror' ? 'active' : ''} type="button" onClick={() => activateTool('mirror')} title="Mirror model">
                      <FlipHorizontal2 size={16} /><span>Mirror</span>
                    </button>
                  </div>
                  <div className="editor-history-group">
                    <button type="button" onClick={undo} disabled={!history.past.length} title="Undo (⌘Z)"><Undo2 size={16} /></button>
                    <button type="button" onClick={redo} disabled={!history.future.length} title="Redo (⌘⇧Z)"><Redo2 size={16} /></button>
                  </div>
                </div>
              ) : null}
              <ModelViewport
                source={source}
                model={voxelModel}
                mode={previewMode}
                showGrid={showGrid}
                tool={tool}
                mirrorSettings={mirrorSettings}
                mirrorPreview={mirrorPreview}
                onVoxelAction={handleVoxelAction}
              />
              <div className="view-hint">
                {previewMode === 'voxel' && tool !== 'orbit'
                  ? tool === 'mirror' ? 'GHOST VOXELS SHOW THE MIRRORED RESULT · DRAG TO ORBIT' : `CLICK A VOXEL FACE TO ${TOOL_LABELS[tool].toUpperCase()} · DRAG TO ORBIT`
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
                <Upload size={18} /> Choose a GLB model
              </button>
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
              <strong>Drop GLB to voxelize</strong>
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
              ) : (
                <button className="compact-upload" type="button" onClick={() => inputRef.current?.click()}>
                  <Upload size={17} /> Select a .glb file
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
              <section className="panel-section editor-section">
                <div className="section-title">
                  <div><PaintBucket size={16} /> VOXEL EDITOR</div>
                  <span>{TOOL_LABELS[tool].toUpperCase()}</span>
                </div>

                {tool !== 'mirror' ? (
                  <>
                    <div className="editor-instruction">
                      {tool === 'orbit' ? 'Choose Add, Erase, or Paint, then click directly on the model.' :
                        tool === 'add' ? 'Click a voxel face to place a new voxel beside it.' :
                          tool === 'remove' ? 'Click a voxel to remove it from the model.' :
                            'Click a voxel to replace its color.'}
                    </div>
                    <div className="control-label editor-color-label">
                      <span>Paint color</span>
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
                            onClick={() => selectPaletteColor(color)}
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
                            if (tool === 'orbit') activateTool('paint');
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
                            if (tool === 'orbit') activateTool('paint');
                          }
                        }}
                      />
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
            {error ? <div className="error-message"><Info size={15} /> {error}</div> : null}
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
                <Download size={16} /> Export .VOX
              </button>
              <button type="button" disabled={!voxelModel || busy} onClick={() => voxelModel && downloadPalette(voxelModel)} title="Export palette PNG">
                <ImageIcon size={16} /> Palette
              </button>
            </div>
            <div className="format-note"><Palette size={13} /> MagicaVoxel palette · Z-up export</div>
          </div>
        </aside>
      </main>

      <input
        ref={inputRef}
        hidden
        type="file"
        accept=".glb,model/gltf-binary"
        onChange={(event) => {
          void receiveFile(event.target.files?.[0]);
          event.target.value = '';
        }}
      />
    </div>
  );
}

export default App;
