import { describe, expect, it } from 'vitest';
import { createPostProcessingSettings, limitFocusStep } from './PostProcessingRuntime';

describe('post-processing settings', () => {
  it('deep-merges partial saved settings without dropping defaults', () => {
    const settings = createPostProcessingSettings({
      bloom: { strength: 0.9 } as never,
      color: { vignette: { strength: 0.4 } } as never,
    });

    expect(settings.bloom.strength).toBe(0.9);
    expect(settings.bloom.radius).toBeGreaterThan(0);
    expect(settings.color.vignette.strength).toBe(0.4);
    expect(settings.color.vignette.softness).toBeGreaterThan(0);
    expect(settings.flare.ghosts.enabled).toBe(true);
    expect(settings.ambientOcclusion.enabled).toBe(true);
    expect(settings.chromaticAberration.amount).toBeGreaterThan(0);
    expect(settings.depthOfField.enabled).toBe(false);
    expect(settings.depthOfField.autofocus).toBe(true);
    expect(settings.antiAliasing).toEqual({ method: 'msaa', msaaSamples: 4, postSmaa: true });
    expect(settings.renderScale).toBe(1);
  });

  it('limits autofocus travel per frame', () => {
    expect(limitFocusStep(0.5, 8, 1.5, 0.1)).toBeCloseTo(0.65);
    expect(limitFocusStep(3, 0.2, 1, 0.25)).toBeCloseTo(2.75);
  });
});
