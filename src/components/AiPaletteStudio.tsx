import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { VoxelModel } from '../types';
import {
  AI_PALETTE_MAX_COLORS,
  AI_PALETTE_MIN_COLORS,
  buildAiPaletteRequest,
  rgbToHex,
  type AiPaletteSuggestion,
} from '../lib/aiPaletteContract';
import { requestAiPalettes } from '../lib/aiPaletteClient';
import {
  applyPaletteRemapPlan,
  planVoxelPaletteRemap,
  type PaletteRemapMode,
  type PaletteRemapPlan,
  type PaletteRemapScope,
} from '../lib/paletteRemap';
import { packVoxelCoordinate } from '../lib/voxelIndex';

interface AiPaletteStudioProps {
  model: VoxelModel;
  selection: ReadonlySet<number>;
  selectedVoxelCount: number;
  onPreview: (base: VoxelModel, preview: PaletteRemapPlan | null) => void;
  onApply: (base: VoxelModel, result: VoxelModel) => boolean;
}

type RequestState = 'idle' | 'requesting' | 'ready' | 'error';

const initialTargetSize = (model: VoxelModel) => Math.min(16, Math.max(4, Math.min(AI_PALETTE_MAX_COLORS, model.palette.length)));

export function AiPaletteStudio({ model, selection, selectedVoxelCount, onPreview, onApply }: AiPaletteStudioProps) {
  const requestController = useRef<AbortController | null>(null);
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const generateButtonRef = useRef<HTMLButtonElement>(null);
  const firstCandidateRef = useRef<HTMLInputElement>(null);
  const [prompt, setPrompt] = useState('');
  const [targetColorCount, setTargetColorCount] = useState(() => initialTargetSize(model));
  const [scope, setScope] = useState<PaletteRemapScope>('model');
  const [mode, setMode] = useState<PaletteRemapMode>('tonal');
  const [lockedColors, setLockedColors] = useState<Set<string>>(() => new Set());
  const [requestState, setRequestState] = useState<RequestState>('idle');
  const [suggestions, setSuggestions] = useState<AiPaletteSuggestion[]>([]);
  const [activeSuggestionId, setActiveSuggestionId] = useState<string | null>(null);
  const [showCandidate, setShowCandidate] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const clearResults = useCallback(() => {
    setSuggestions([]);
    setActiveSuggestionId(null);
    setRequestState('idle');
    setError(null);
    onPreview(model, null);
  }, [model, onPreview]);

  useEffect(() => {
    requestController.current?.abort();
    requestController.current = null;
    setTargetColorCount(initialTargetSize(model));
    setLockedColors(new Set());
    setSuggestions([]);
    setActiveSuggestionId(null);
    setRequestState('idle');
    setError(null);
    onPreview(model, null);
  }, [model, onPreview]);

  useEffect(() => () => {
    requestController.current?.abort();
    onPreview(model, null);
  }, [model, onPreview]);

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
    });
  }, [activeSuggestion, lockedColors, mode, model, scope, selection]);

  useEffect(() => {
    onPreview(model, showCandidate ? preview : null);
  }, [model, onPreview, preview, showCandidate]);

  useEffect(() => {
    if (scope !== 'selection') return;
    requestController.current?.abort();
    requestController.current = null;
    setSuggestions([]);
    setActiveSuggestionId(null);
    setRequestState('idle');
    setError(null);
    onPreview(model, null);
  }, [model, onPreview, scope, selection]);

  const changeScope = (nextScope: PaletteRemapScope) => {
    if (nextScope === 'selection' && !selectedVoxelCount) return;
    clearResults();
    setScope(nextScope);
  };

  const toggleLock = (hex: string) => {
    if (!lockedColors.has(hex) && lockedColors.size >= AI_PALETTE_MAX_COLORS) {
      setError(`AI palettes support up to ${AI_PALETTE_MAX_COLORS} locked colors.`);
      return;
    }
    clearResults();
    const next = new Set(lockedColors);
    if (next.has(hex)) next.delete(hex); else next.add(hex);
    setLockedColors(next);
    setTargetColorCount((size) => Math.max(size, next.size, AI_PALETTE_MIN_COLORS));
  };

  const generate = async () => {
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
    setSuggestions([]);
    setActiveSuggestionId(null);
    setRequestState('idle');
    window.requestAnimationFrame(() => promptRef.current?.focus());
  };

  const discardResults = () => {
    clearResults();
    window.requestAnimationFrame(() => generateButtonRef.current?.focus());
  };

  return (
    <div className="ai-studio" aria-busy={requestState === 'requesting'}>
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

      <div className="ai-control-block">
        <label className="control-label" htmlFor="ai-palette-size">
          <span>Target colors</span><output>{targetColorCount}<small> colors</small></output>
        </label>
        <input
          id="ai-palette-size"
          className="range"
          type="range"
          min={Math.max(AI_PALETTE_MIN_COLORS, lockedInScope)}
          max={AI_PALETTE_MAX_COLORS}
          value={targetColorCount}
          disabled={requestState === 'requesting'}
          onChange={(event) => { clearResults(); setTargetColorCount(Number(event.target.value)); }}
        />
        <div className="range-scale"><span>{Math.max(AI_PALETTE_MIN_COLORS, lockedInScope)}</span><span>Focused palette</span><span>{AI_PALETTE_MAX_COLORS}</span></div>
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
          <button type="button" className={mode === 'tonal' ? 'active' : ''} aria-pressed={mode === 'tonal'} onClick={() => setMode('tonal')}>
            <strong>Preserve tones</strong><small>Best for restyling</small>
          </button>
          <button type="button" className={mode === 'appearance' ? 'active' : ''} aria-pressed={mode === 'appearance'} onClick={() => setMode('appearance')}>
            <strong>Closest color</strong><small>Best for subtle edits</small>
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
                disabled={requestState === 'requesting' || (!locked && lockedColors.size >= AI_PALETTE_MAX_COLORS)}
                onClick={() => toggleLock(hex)}
              />
            );
          })}
        </div>
      </div>

      <p id="ai-palette-privacy" className="ai-privacy">
        AI receives this prompt plus palette swatches and usage counts. An anonymous installation ID and your network IP are used only for rate limiting. Your GLB, voxel geometry and coordinates stay on this device.
      </p>

      {allTargetSlotsLocked ? <p className="ai-warning">Unlock a color or increase the target size to leave AI at least one creative palette slot.</p> : null}

      {error ? <div className="ai-inline-error" role="alert">{error}</div> : null}
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

      {suggestions.length ? (
        <div className="ai-results">
          <fieldset className="ai-candidates">
            <legend>Palette directions</legend>
            {suggestions.map((suggestion, index) => (
              <label key={suggestion.id} className={activeSuggestionId === suggestion.id ? 'active' : ''}>
                <input ref={index === 0 ? firstCandidateRef : undefined} type="radio" name="ai-palette-candidate" value={suggestion.id} checked={activeSuggestionId === suggestion.id} onChange={() => { setActiveSuggestionId(suggestion.id); setShowCandidate(true); }} />
                <span className="ai-candidate-copy"><strong>{suggestion.name}</strong><small>{suggestion.description}</small></span>
                <span className="ai-candidate-strip" aria-label={`${suggestion.name} colors`}>{suggestion.colors.map((color) => <i key={color} style={{ background: color }} />)}</span>
              </label>
            ))}
          </fieldset>

          {preview ? (
            <div className="ai-preview-summary">
              <p className="sr-only" role="status" aria-live="polite">{activeSuggestion?.name} preview ready. {preview.metrics.changedVoxels.toLocaleString()} voxels will change.</p>
              <div className="ai-preview-toggle" role="group" aria-label="Palette preview">
                <button type="button" className={!showCandidate ? 'active' : ''} aria-pressed={!showCandidate} onClick={() => setShowCandidate(false)}>Current</button>
                <button type="button" className={showCandidate ? 'active' : ''} aria-pressed={showCandidate} onClick={() => setShowCandidate(true)}>Candidate</button>
              </div>
              <div className="ai-metrics">
                <span><strong>{preview.metrics.changedVoxels.toLocaleString()}</strong> voxels changed</span>
                <span><strong>{preview.metrics.targetColorsUsed}</strong> colors used</span>
                <span><strong>{preview.metrics.meanColorMovement.toFixed(1)}</strong> tone shift</span>
              </div>
              {preview.warnings.map((warning) => <p className="ai-warning" key={warning}>{warning}</p>)}
              {!preview.metrics.changedVoxels ? <p className="ai-warning">This candidate already matches the chosen scope.</p> : null}
              <div className="ai-result-actions">
                <button type="button" onClick={discardResults}>Discard</button>
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
