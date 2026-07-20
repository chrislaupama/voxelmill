import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { VoxelModel } from '../types';
import {
  buildAiPaletteRequest,
  rgbToHex,
  type AiPaletteSuggestion,
} from '../lib/aiPaletteContract';
import { requestAiPalettes } from '../lib/aiPaletteClient';
import { extractReferencePalette, type ReferencePaletteResult } from '../lib/referencePalette';
import {
  applyPaletteRemapPlan,
  preparePaletteCandidate,
  planVoxelPaletteRemap,
  type PaletteContrastMode,
  type PaletteRemapMode,
  type PaletteRemapPlan,
  type PaletteRemapScope,
} from '../lib/paletteRemap';
import { packVoxelCoordinate } from '../lib/voxelIndex';
import {
  assertSupportedReferenceImageDimensions,
  boundedReferenceImageDimensions,
  initialAiPaletteTargetSize,
  isSupportedReferenceImage,
  PALETTE_STUDIO_MAX_COLORS,
  PALETTE_STUDIO_MIN_COLORS,
  REFERENCE_IMAGE_MAX_FILE_BYTES,
} from './aiPaletteStudioState';

interface AiPaletteStudioProps {
  model: VoxelModel;
  selection: ReadonlySet<number>;
  selectedVoxelCount: number;
  onPreview: (base: VoxelModel, preview: PaletteRemapPlan | null) => void;
  onApply: (base: VoxelModel, result: VoxelModel) => boolean;
}

type RequestState = 'idle' | 'requesting' | 'ready' | 'error';
type PaletteSource = 'reference' | 'ai';
type ReferenceState = 'idle' | 'loading' | 'ready' | 'error';
const AI_PALETTE_AVAILABLE = import.meta.env.VITE_AI_PALETTE_ENABLED === 'true';

interface DecodedReferenceImage {
  pixels: Uint8ClampedArray;
  width: number;
  height: number;
  sourceWidth: number;
  sourceHeight: number;
}

interface ReferenceImageMeta {
  fileName: string;
  previewUrl: string;
  width: number;
  height: number;
  sourceWidth: number;
  sourceHeight: number;
}

async function decodeReferenceImage(file: File): Promise<DecodedReferenceImage> {
  let source: CanvasImageSource;
  let width: number;
  let height: number;
  let release = () => {};

  if (typeof createImageBitmap === 'function') {
    const bitmap = await createImageBitmap(file);
    source = bitmap;
    width = bitmap.width;
    height = bitmap.height;
    release = () => bitmap.close();
  } else {
    const objectUrl = URL.createObjectURL(file);
    const image = new Image();
    image.decoding = 'async';
    image.src = objectUrl;
    try {
      await image.decode();
    } catch {
      URL.revokeObjectURL(objectUrl);
      throw new Error('The selected image could not be decoded. Try a different PNG, JPEG, or WebP file.');
    }
    source = image;
    width = image.naturalWidth;
    height = image.naturalHeight;
    release = () => URL.revokeObjectURL(objectUrl);
  }

  try {
    assertSupportedReferenceImageDimensions(width, height);
    const bounded = boundedReferenceImageDimensions(width, height);
    const canvas = document.createElement('canvas');
    canvas.width = bounded.width;
    canvas.height = bounded.height;
    const context = canvas.getContext('2d', { alpha: true, willReadFrequently: true });
    if (!context) throw new Error('This browser cannot read reference image pixels.');
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';
    context.drawImage(source, 0, 0, bounded.width, bounded.height);
    const imageData = context.getImageData(0, 0, bounded.width, bounded.height);
    return {
      pixels: imageData.data,
      width: bounded.width,
      height: bounded.height,
      sourceWidth: width,
      sourceHeight: height,
    };
  } finally {
    release();
  }
}

export function AiPaletteStudio({ model, selection, selectedVoxelCount, onPreview, onApply }: AiPaletteStudioProps) {
  const requestController = useRef<AbortController | null>(null);
  const referenceInputRef = useRef<HTMLInputElement>(null);
  const referenceChooseButtonRef = useRef<HTMLButtonElement>(null);
  const referencePixelsRef = useRef<DecodedReferenceImage | null>(null);
  const referenceLoadId = useRef(0);
  const paletteSourceRef = useRef<PaletteSource>('reference');
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const generateButtonRef = useRef<HTMLButtonElement>(null);
  const firstCandidateRef = useRef<HTMLInputElement>(null);
  const [paletteSource, setPaletteSource] = useState<PaletteSource>('reference');
  const [prompt, setPrompt] = useState('');
  const [targetColorCount, setTargetColorCount] = useState(() => initialAiPaletteTargetSize(model.palette.length));
  const [scope, setScope] = useState<PaletteRemapScope>('model');
  const [mode, setMode] = useState<PaletteRemapMode>('tonal');
  const [contrast, setContrast] = useState<PaletteContrastMode>('readable');
  const [lockedColors, setLockedColors] = useState<Set<string>>(() => new Set());
  const [requestState, setRequestState] = useState<RequestState>('idle');
  const [suggestions, setSuggestions] = useState<AiPaletteSuggestion[]>([]);
  const [activeSuggestionId, setActiveSuggestionId] = useState<string | null>(null);
  const [showCandidate, setShowCandidate] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [referenceState, setReferenceState] = useState<ReferenceState>('idle');
  const [referenceImage, setReferenceImage] = useState<ReferenceImageMeta | null>(null);
  const [referenceResult, setReferenceResult] = useState<ReferencePaletteResult | null>(null);
  paletteSourceRef.current = paletteSource;

  const clearResults = useCallback(() => {
    setSuggestions([]);
    setActiveSuggestionId(null);
    setRequestState('idle');
    setError(null);
    onPreview(model, null);
  }, [model, onPreview]);

  const showReferenceCandidate = useCallback((result: ReferencePaletteResult) => {
    setReferenceResult(result);
    if (!result.palette.length) {
      setSuggestions([]);
      setActiveSuggestionId(null);
      setRequestState('idle');
      setReferenceState('error');
      setError(result.warnings[0]?.message ?? 'No visible colors could be extracted from this image.');
      onPreview(model, null);
      return;
    }
    const suggestion: AiPaletteSuggestion = {
      id: `reference-${result.diagnostics.targetColorCount}-${result.palette.map(rgbToHex).join('-')}`,
      name: 'Reference image',
      description: `${result.palette.length} local swatches from ${result.diagnostics.visiblePixels.toLocaleString()} sampled pixels.`,
      colors: result.palette.map(rgbToHex),
    };
    setSuggestions([suggestion]);
    setActiveSuggestionId(suggestion.id);
    setShowCandidate(true);
    setRequestState('ready');
    setReferenceState('ready');
    setError(null);
  }, [model, onPreview]);

  const extractLoadedReference = useCallback((colorCount: number) => {
    const decoded = referencePixelsRef.current;
    if (!decoded) return;
    try {
      showReferenceCandidate(extractReferencePalette(decoded.pixels, decoded.width, decoded.height, { colorCount }));
    } catch (referenceError) {
      setReferenceState('error');
      setRequestState('error');
      setError(referenceError instanceof Error ? referenceError.message : 'The reference palette could not be extracted.');
      onPreview(model, null);
    }
  }, [model, onPreview, showReferenceCandidate]);

  useEffect(() => {
    requestController.current?.abort();
    requestController.current = null;
    const nextTargetColorCount = initialAiPaletteTargetSize(model.palette.length);
    setTargetColorCount(nextTargetColorCount);
    setLockedColors(new Set());
    setSuggestions([]);
    setActiveSuggestionId(null);
    setRequestState('idle');
    setError(null);
    onPreview(model, null);
    if (paletteSourceRef.current === 'reference' && referencePixelsRef.current) extractLoadedReference(nextTargetColorCount);
  }, [extractLoadedReference, model, onPreview]);

  useEffect(() => () => {
    requestController.current?.abort();
    referenceLoadId.current += 1;
    onPreview(model, null);
  }, [model, onPreview]);

  useEffect(() => () => {
    if (referenceImage?.previewUrl) URL.revokeObjectURL(referenceImage.previewUrl);
  }, [referenceImage]);

  const activeSuggestion = suggestions.find((suggestion) => suggestion.id === activeSuggestionId) ?? null;
  const scopeColors = useMemo(() => {
    const colors = new Set<string>();
    for (const voxel of model.voxels) {
      if (scope === 'selection' && !selection.has(packVoxelCoordinate(voxel))) continue;
      colors.add(rgbToHex(model.palette[voxel.colorIndex]));
    }
    return colors;
  }, [model, scope, selection]);
  const lockedInScope = [...lockedColors].filter((color) => scopeColors.has(color)).length;
  const allTargetSlotsLocked = lockedInScope >= targetColorCount;

  const preview = useMemo<PaletteRemapPlan | null>(() => {
    if (!activeSuggestion) return null;
    return planVoxelPaletteRemap(model, activeSuggestion.colors, {
      scope,
      selection: scope === 'selection' ? selection : undefined,
      lockedColors,
      mode,
      contrast,
    });
  }, [activeSuggestion, contrast, lockedColors, mode, model, scope, selection]);

  useEffect(() => {
    onPreview(model, showCandidate ? preview : null);
  }, [model, onPreview, preview, showCandidate]);

  useEffect(() => {
    if (scope !== 'selection' || paletteSource !== 'ai') return;
    requestController.current?.abort();
    requestController.current = null;
    setSuggestions([]);
    setActiveSuggestionId(null);
    setRequestState('idle');
    setError(null);
    onPreview(model, null);
  }, [model, onPreview, paletteSource, scope, selection]);

  const changePaletteSource = (nextSource: PaletteSource) => {
    if (nextSource === paletteSource) return;
    requestController.current?.abort();
    requestController.current = null;
    clearResults();
    setPaletteSource(nextSource);
    if (nextSource === 'reference' && referencePixelsRef.current) {
      extractLoadedReference(targetColorCount);
      window.requestAnimationFrame(() => referenceChooseButtonRef.current?.focus());
    } else if (nextSource === 'ai') {
      window.requestAnimationFrame(() => promptRef.current?.focus());
    }
  };

  const changeScope = (nextScope: PaletteRemapScope) => {
    if (nextScope === 'selection' && !selectedVoxelCount) return;
    if (paletteSource === 'ai') clearResults();
    setScope(nextScope);
    setShowCandidate(true);
  };

  const toggleLock = (hex: string) => {
    if (!lockedColors.has(hex) && lockedColors.size >= PALETTE_STUDIO_MAX_COLORS) {
      setError(`Palette Studio supports up to ${PALETTE_STUDIO_MAX_COLORS} locked colors.`);
      return;
    }
    if (paletteSource === 'ai') clearResults();
    const next = new Set(lockedColors);
    if (next.has(hex)) next.delete(hex); else next.add(hex);
    setLockedColors(next);
    const nextTargetColorCount = Math.max(targetColorCount, next.size, PALETTE_STUDIO_MIN_COLORS);
    setTargetColorCount(nextTargetColorCount);
    if (paletteSource === 'reference' && nextTargetColorCount !== targetColorCount && referencePixelsRef.current) {
      extractLoadedReference(nextTargetColorCount);
    }
  };

  const changeTargetColorCount = (nextColorCount: number) => {
    clearResults();
    setTargetColorCount(nextColorCount);
    if (paletteSource === 'reference' && referencePixelsRef.current) extractLoadedReference(nextColorCount);
  };

  const chooseReferenceImage = async (file: File | undefined) => {
    if (!file) return;
    if (!isSupportedReferenceImage(file)) {
      setReferenceState('error');
      setError(`Choose a non-empty PNG, JPEG, or WebP image up to ${Math.round(REFERENCE_IMAGE_MAX_FILE_BYTES / 1024 / 1024)} MB.`);
      return;
    }
    const loadId = referenceLoadId.current + 1;
    referenceLoadId.current = loadId;
    clearResults();
    setReferenceResult(null);
    setReferenceState('loading');
    try {
      const decoded = await decodeReferenceImage(file);
      if (referenceLoadId.current !== loadId) return;
      referencePixelsRef.current = decoded;
      setReferenceImage({
        fileName: file.name,
        previewUrl: URL.createObjectURL(file),
        width: decoded.width,
        height: decoded.height,
        sourceWidth: decoded.sourceWidth,
        sourceHeight: decoded.sourceHeight,
      });
      extractLoadedReference(targetColorCount);
    } catch (decodeError) {
      if (referenceLoadId.current !== loadId) return;
      setReferenceState('error');
      setRequestState('error');
      setError(decodeError instanceof Error ? decodeError.message : 'The reference image could not be read.');
    }
  };

  const removeReferenceImage = () => {
    referenceLoadId.current += 1;
    referencePixelsRef.current = null;
    setReferenceImage(null);
    setReferenceResult(null);
    setReferenceState('idle');
    clearResults();
    if (referenceInputRef.current) referenceInputRef.current.value = '';
    window.requestAnimationFrame(() => referenceChooseButtonRef.current?.focus());
  };

  const generate = async () => {
    if (paletteSource !== 'ai') return;
    requestController.current?.abort();
    const controller = new AbortController();
    requestController.current = controller;
    onPreview(model, null);
    setSuggestions([]);
    setActiveSuggestionId(null);
    setError(null);
    setRequestState('requesting');
    const timeout = window.setTimeout(() => controller.abort('timeout'), 45_000);
    try {
      const request = buildAiPaletteRequest(
        model,
        prompt,
        targetColorCount,
        lockedColors,
        scope === 'selection' ? selection : undefined,
      );
      const response = await requestAiPalettes(request, controller.signal);
      if (requestController.current !== controller) return;
      setSuggestions(response.suggestions);
      setActiveSuggestionId(response.suggestions[0]?.id ?? null);
      setShowCandidate(true);
      setRequestState('ready');
      window.requestAnimationFrame(() => firstCandidateRef.current?.focus());
    } catch (requestError) {
      if (requestController.current !== controller) return;
      if (controller.signal.aborted && controller.signal.reason !== 'timeout') {
        setRequestState('idle');
      } else {
        setError(controller.signal.reason === 'timeout'
          ? 'Palette generation took too long. Please try again.'
          : requestError instanceof Error ? requestError.message : 'The palette could not be generated.');
        setRequestState('error');
      }
    } finally {
      window.clearTimeout(timeout);
      if (requestController.current === controller) requestController.current = null;
    }
  };

  const cancelRequest = () => {
    requestController.current?.abort();
    requestController.current = null;
    setRequestState('idle');
    window.requestAnimationFrame(() => generateButtonRef.current?.focus());
  };

  const apply = () => {
    if (!preview || !preview.metrics.changedVoxels) return;
    if (!onApply(model, applyPaletteRemapPlan(model, preview))) {
      setError('The model changed after this preview was generated. Generate a fresh palette and try again.');
      setRequestState('error');
      return;
    }
    if (paletteSource === 'reference' && referencePixelsRef.current) {
      extractLoadedReference(targetColorCount);
    } else {
      setSuggestions([]);
      setActiveSuggestionId(null);
      setRequestState('idle');
    }
    window.requestAnimationFrame(() => (paletteSource === 'ai' ? promptRef.current : referenceChooseButtonRef.current)?.focus());
  };

  const discardResults = () => {
    if (paletteSource === 'reference') {
      setReferenceResult(null);
      setReferenceState('idle');
      clearResults();
      window.requestAnimationFrame(() => referenceChooseButtonRef.current?.focus());
      return;
    }
    clearResults();
    window.requestAnimationFrame(() => generateButtonRef.current?.focus());
  };

  return (
    <div className="ai-studio" aria-busy={requestState === 'requesting' || referenceState === 'loading'}>
      <fieldset className="ai-control-group ai-source-switch">
        <legend>Palette source</legend>
        <div className="ai-option-grid">
          <button type="button" className={paletteSource === 'reference' ? 'active' : ''} aria-pressed={paletteSource === 'reference'} disabled={requestState === 'requesting'} onClick={() => changePaletteSource('reference')}>
            <strong>Reference image</strong><small>Local · no AI / no bill</small>
          </button>
          <button type="button" className={paletteSource === 'ai' ? 'active' : ''} aria-pressed={paletteSource === 'ai'} disabled={!AI_PALETTE_AVAILABLE || referenceState === 'loading'} onClick={() => changePaletteSource('ai')}>
            <strong>Describe with AI</strong><small>{AI_PALETTE_AVAILABLE ? 'Can incur AI usage' : 'Beta paused · no usage'}</small>
          </button>
        </div>
      </fieldset>

      {paletteSource === 'reference' ? (
        <div className="ai-reference-source">
          <input
            ref={referenceInputRef}
            className="sr-only"
            id="reference-palette-file"
            type="file"
            accept="image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp"
            aria-label="Reference image file"
            aria-describedby="reference-palette-privacy"
            onChange={(event) => {
              const file = event.currentTarget.files?.[0];
              event.currentTarget.value = '';
              void chooseReferenceImage(file);
            }}
          />
          {referenceImage ? (
            <div className="ai-reference-card">
              <img src={referenceImage.previewUrl} alt={`Reference preview: ${referenceImage.fileName}`} />
              <span>
                <strong>{referenceImage.fileName}</strong>
                <small>{referenceImage.sourceWidth.toLocaleString()} × {referenceImage.sourceHeight.toLocaleString()} px · sampled at {referenceImage.width} × {referenceImage.height}</small>
              </span>
              <button ref={referenceChooseButtonRef} type="button" disabled={referenceState === 'loading'} onClick={() => extractLoadedReference(targetColorCount)}>Re-extract</button>
              <button type="button" disabled={referenceState === 'loading'} onClick={() => referenceInputRef.current?.click()}>Replace</button>
              <button type="button" disabled={referenceState === 'loading'} onClick={removeReferenceImage}>Remove</button>
            </div>
          ) : (
            <button ref={referenceChooseButtonRef} className="primary ai-reference-choose" type="button" disabled={referenceState === 'loading'} onClick={() => referenceInputRef.current?.click()}>
              Choose PNG, JPEG, or WebP
            </button>
          )}
          <p id="reference-palette-privacy" className="ai-privacy">
            Your image is decoded, downsampled and reduced to swatches entirely in this browser. It is never uploaded, uses no AI, and creates no billable AI request.
          </p>
          {referenceState === 'loading' ? (
            <div className="ai-request-row">
              <span className="ai-spinner" aria-hidden="true" />
              <span role="status" aria-live="polite">Reading and sampling the reference image locally…</span>
            </div>
          ) : null}
        </div>
      ) : (
        <>
          <label className="ai-prompt-label" htmlFor="ai-palette-prompt">Describe the look</label>
          <textarea
            ref={promptRef}
            id="ai-palette-prompt"
            value={prompt}
            maxLength={500}
            rows={3}
            disabled={requestState === 'requesting'}
            placeholder="e.g. military olive metal, deep shadows, worn brass and a restrained orange energy accent"
            aria-describedby="ai-palette-privacy"
            onChange={(event) => { if (suggestions.length) clearResults(); setPrompt(event.target.value); }}
          />
          <div className="ai-prompt-meta"><span>Style, materials and accents work best</span><span>{prompt.length}/500</span></div>
        </>
      )}

      <div className="ai-control-block">
        <label className="control-label" htmlFor="ai-palette-size">
          <span>Target colors</span><output>{targetColorCount}<small> colors</small></output>
        </label>
        <input
          id="ai-palette-size"
          className="range"
          type="range"
          min={Math.max(PALETTE_STUDIO_MIN_COLORS, lockedInScope)}
          max={PALETTE_STUDIO_MAX_COLORS}
          value={targetColorCount}
          disabled={requestState === 'requesting' || referenceState === 'loading'}
          onChange={(event) => changeTargetColorCount(Number(event.target.value))}
        />
        <div className="range-scale"><span>{Math.max(PALETTE_STUDIO_MIN_COLORS, lockedInScope)}</span><span>Focused palette</span><span>{PALETTE_STUDIO_MAX_COLORS}</span></div>
      </div>

      <fieldset className="ai-control-block ai-control-group">
        <legend>Apply to</legend>
        <div className="ai-option-grid">
          <button type="button" className={scope === 'model' ? 'active' : ''} aria-pressed={scope === 'model'} disabled={requestState === 'requesting'} onClick={() => changeScope('model')}>
            <strong>Whole model</strong><small>{model.voxels.length.toLocaleString()} voxels</small>
          </button>
          <button type="button" className={scope === 'selection' ? 'active' : ''} aria-pressed={scope === 'selection'} disabled={!selectedVoxelCount || requestState === 'requesting'} onClick={() => changeScope('selection')}>
            <strong>Selection</strong><small>{selectedVoxelCount ? `${selectedVoxelCount.toLocaleString()} voxels` : 'Select voxels first'}</small>
          </button>
        </div>
      </fieldset>

      <fieldset className="ai-control-block ai-control-group">
        <legend>Color mapping</legend>
        <div className="ai-option-grid">
          <button type="button" className={mode === 'tonal' ? 'active' : ''} aria-pressed={mode === 'tonal'} disabled={requestState === 'requesting' || referenceState === 'loading'} onClick={() => setMode('tonal')}>
            <strong>Preserve tones</strong><small>Best for restyling</small>
          </button>
          <button type="button" className={mode === 'appearance' ? 'active' : ''} aria-pressed={mode === 'appearance'} disabled={requestState === 'requesting' || referenceState === 'loading'} onClick={() => setMode('appearance')}>
            <strong>Keep appearance</strong><small>Prefer nearby hue families</small>
          </button>
        </div>
      </fieldset>

      <fieldset className="ai-control-block ai-control-group">
        <legend>Palette quality</legend>
        <div className="ai-option-grid">
          <button type="button" className={contrast === 'readable' ? 'active' : ''} aria-pressed={contrast === 'readable'} disabled={requestState === 'requesting' || referenceState === 'loading'} onClick={() => { setContrast('readable'); setShowCandidate(true); }}>
            <strong>Readable</strong><small>Separate muddy tones</small>
          </button>
          <button type="button" className={contrast === 'exact' ? 'active' : ''} aria-pressed={contrast === 'exact'} disabled={requestState === 'requesting' || referenceState === 'loading'} onClick={() => { setContrast('exact'); setShowCandidate(true); }}>
            <strong>Exact swatches</strong><small>Keep source colors unchanged</small>
          </button>
        </div>
      </fieldset>

      <div className="ai-control-block">
        <div className="control-label"><span>Lock current colors</span><output>{lockedColors.size}<small> locked</small></output></div>
        <p className="ai-help">Locked swatches remain exact. Equal colors are locked together.</p>
        <div className="palette-grid ai-lock-grid" role="group" aria-label="Colors to preserve">
          {model.palette.map((color, index) => {
            const hex = rgbToHex(color);
            const locked = lockedColors.has(hex);
            return (
              <button
                type="button"
                key={`${hex}-${index}`}
                className={locked ? 'locked' : ''}
                style={{ background: hex }}
                aria-pressed={locked}
                aria-label={`${locked ? 'Unlock' : 'Lock'} palette color ${index + 1}: ${hex}`}
                disabled={requestState === 'requesting' || referenceState === 'loading' || (!locked && lockedColors.size >= PALETTE_STUDIO_MAX_COLORS)}
                onClick={() => toggleLock(hex)}
              />
            );
          })}
        </div>
      </div>

      {error ? <div className="ai-inline-error" role="alert">{error}</div> : null}
      {paletteSource === 'ai' ? (
        <>
          <p id="ai-palette-privacy" className="ai-privacy">
            This path sends the prompt plus palette swatches and usage counts to the AI service and can incur AI usage or billing. The edge limiter derives a rotating opaque key; raw addresses and client IDs are not written to app storage or logs. Your GLB, voxel geometry and coordinates stay on this device.
          </p>
          {allTargetSlotsLocked ? <p className="ai-warning">Unlock a color or increase the target size to leave AI at least one creative palette slot.</p> : null}
          {requestState === 'requesting' ? (
            <div className="ai-request-row">
              <span className="ai-spinner" aria-hidden="true" />
              <span role="status" aria-live="polite">Directing three palette concepts…</span>
              <button type="button" onClick={cancelRequest}>Cancel</button>
            </div>
          ) : (
            <button ref={generateButtonRef} className="primary ai-generate" type="button" disabled={!prompt.trim() || allTargetSlotsLocked || (scope === 'selection' && !selectedVoxelCount)} onClick={() => void generate()}>
              Generate 3 palettes
            </button>
          )}
        </>
      ) : null}

      {suggestions.length ? (
        <div className="ai-results">
          <fieldset className="ai-candidates">
            <legend>{paletteSource === 'reference' ? 'Extracted palette' : 'Palette directions'}</legend>
            {suggestions.map((suggestion, index) => {
              const active = activeSuggestionId === suggestion.id;
              const displayedColors = (active && preview
                ? preview.preparedPalette
                : preparePaletteCandidate(suggestion.colors, lockedColors, contrast)).map(rgbToHex);
              return (
                <label key={suggestion.id} className={active ? 'active' : ''}>
                  <input ref={index === 0 ? firstCandidateRef : undefined} type="radio" name="palette-candidate" value={suggestion.id} checked={active} onChange={() => { setActiveSuggestionId(suggestion.id); setShowCandidate(true); }} />
                  <span className="ai-candidate-copy"><strong>{suggestion.name}</strong><small>{suggestion.description}</small></span>
                  <span className="ai-candidate-strip" aria-label={`${suggestion.name} prepared colors`}>{displayedColors.map((color) => <i key={color} style={{ background: color }} />)}</span>
                </label>
              );
            })}
          </fieldset>

          {paletteSource === 'reference' && referenceResult ? (
            <div className="ai-reference-diagnostics" aria-label="Reference extraction diagnostics">
              <div className="ai-metrics">
                <span><strong>{referenceResult.diagnostics.producedColorCount}</strong> swatches</span>
                <span><strong>{referenceResult.diagnostics.visiblePixels.toLocaleString()}</strong> pixels sampled</span>
                <span><strong>{referenceResult.diagnostics.meaningfulFamiliesPreserved}/{referenceResult.diagnostics.meaningfulFamiliesDetected}</strong> families kept</span>
                <span><strong>{referenceResult.diagnostics.accentFamiliesPreserved}/{referenceResult.diagnostics.accentFamiliesDetected}</strong> accents kept</span>
                <span><strong>{referenceResult.diagnostics.meanPerceptualError.toFixed(1)}</strong> mean error</span>
                <span><strong>{referenceResult.diagnostics.p95PerceptualError.toFixed(1)}</strong> p95 error</span>
              </div>
              {referenceResult.warnings.map((warning) => <p className="ai-warning" key={warning.code}>{warning.message}</p>)}
            </div>
          ) : null}

          {preview ? (
            <div className="ai-preview-summary">
              <p className="sr-only" role="status" aria-live="polite">{activeSuggestion?.name} preview ready. {preview.metrics.changedVoxels.toLocaleString()} voxels will change.</p>
              <div className="ai-preview-toggle" role="group" aria-label="Palette preview">
                <button type="button" className={!showCandidate ? 'active' : ''} aria-pressed={!showCandidate} onClick={() => setShowCandidate(false)}>Current</button>
                <button type="button" className={showCandidate ? 'active' : ''} aria-pressed={showCandidate} onClick={() => setShowCandidate(true)}>Candidate</button>
              </div>
              <div className="ai-metrics">
                <span><strong>{preview.metrics.changedVoxels.toLocaleString()}</strong> voxels changed</span>
                <span><strong>{preview.appliedPalette.length}/{preview.preparedPalette.length}</strong> used / prepared</span>
                <span><strong>{preview.metrics.toneOrderRetention.toFixed(0)}%</strong> tone order</span>
                <span><strong>{preview.metrics.sourceFamilies}</strong> material ramps</span>
                <span><strong>{Math.round(preview.metrics.lightnessSpan * 100)}%</strong> light range</span>
                <span><strong>{preview.metrics.minimumColorSeparation ? preview.metrics.minimumColorSeparation.toFixed(1) : '—'}</strong> min separation</span>
              </div>
              {preview.warnings.map((warning) => <p className="ai-warning" key={warning}>{warning}</p>)}
              {!preview.metrics.changedVoxels ? <p className="ai-warning">This candidate already matches the chosen scope.</p> : null}
              {preview.mapping.length ? (
                <details className="ai-mapping-comparison">
                  <summary>Inspect source → target mapping</summary>
                  <div className="ai-mapping-list">
                    {[...preview.mapping].sort((left, right) => right.voxelCount - left.voxelCount || left.sourceIndex - right.sourceIndex).map((entry) => {
                      const before = rgbToHex(entry.before);
                      const after = rgbToHex(entry.after);
                      return (
                        <div key={entry.sourceIndex} className="ai-mapping-row">
                          <i role="img" style={{ background: before }} aria-label={`Source ${before}`} />
                          <code>{before}</code>
                          <span aria-hidden="true">→</span>
                          <i role="img" style={{ background: after }} aria-label={`Target ${after}`} />
                          <code>{after}</code>
                          <small>{entry.locked ? 'locked' : `${entry.voxelCount.toLocaleString()} voxels`}</small>
                        </div>
                      );
                    })}
                  </div>
                </details>
              ) : null}
              <div className="ai-result-actions">
                <button type="button" onClick={discardResults}>{paletteSource === 'reference' ? 'Clear palette' : 'Discard'}</button>
                <button className="primary" type="button" disabled={!preview.metrics.changedVoxels} onClick={apply}>
                  Apply to {scope === 'selection' ? `${preview.metrics.affectedVoxels.toLocaleString()} voxels` : 'model'}
                </button>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
