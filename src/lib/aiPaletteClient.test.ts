import { describe, expect, it, vi } from 'vitest';
import { clearLegacyAiClientId } from './aiPaletteClient';

describe('AI palette client privacy migration', () => {
  it('removes the retired persisted client identifier', () => {
    const removeItem = vi.fn();
    clearLegacyAiClientId(() => ({ removeItem }));
    expect(removeItem).toHaveBeenCalledWith('voxelmill-ai-client');
  });

  it('does not fail when browser storage is blocked', () => {
    expect(() => clearLegacyAiClientId(() => { throw new Error('blocked'); })).not.toThrow();
  });
});
