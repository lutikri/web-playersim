import { describe, expect, it } from 'vitest';
import { canPromoteQuality } from './AdaptivePerformanceRuntime';

describe('canPromoteQuality', () => {
  it.each([
    [60, true],
    [50, true],
    [49.9, false],
    [24, false],
  ] as const)('returns %s for %s FPS', (fps, expected) => {
    expect(canPromoteQuality(fps)).toBe(expected);
  });
});
