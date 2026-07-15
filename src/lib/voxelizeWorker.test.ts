import { describe, expect, it } from 'vitest';
import { ConversionCancelledError, isConversionCancelled, monotonicProgress } from './voxelizeWorker';

describe('conversion worker client', () => {
  it('keeps progress bounded and monotonic across worker stages', () => {
    expect(monotonicProgress(0.4, 0.3)).toBe(0.4);
    expect(monotonicProgress(0.4, 0.7)).toBe(0.7);
    expect(monotonicProgress(0.9, 2)).toBe(1);
    expect(monotonicProgress(0, -1)).toBe(0);
  });

  it('distinguishes intentional cancellation from conversion failures', () => {
    expect(isConversionCancelled(new ConversionCancelledError())).toBe(true);
    expect(isConversionCancelled(new Error('decode failed'))).toBe(false);
  });
});
