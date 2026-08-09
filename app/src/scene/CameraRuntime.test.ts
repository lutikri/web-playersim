import { describe, expect, it } from 'vitest';
import { coverFov } from './CameraRuntime';

describe('camera framing', () => {
  it('preserves authored vertical fov at the authored or narrower aspect', () => {
    expect(coverFov(27, 1.5, 1.5)).toBe(27);
    expect(coverFov(27, 1.5, 1)).toBe(27);
  });

  it('crops a wider viewport to preserve the authored horizontal framing', () => {
    expect(coverFov(27, 1.5, 16 / 9)).toBeCloseTo(22.9, 1);
  });
});
