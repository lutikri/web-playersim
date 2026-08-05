import { describe, expect, it } from 'vitest';
import { shouldAllowHighTextureTier } from './TextureStreamingRuntime';

describe('high texture tier policy', () => {
  it('requires sustained performance and capable hardware', () => {
    expect(shouldAllowHighTextureTier({
      averageFps: 58,
      stableSeconds: 12,
      deviceMemoryGb: 8,
      maxTextureSize: 16384,
      saveData: false,
    })).toBe(true);
    expect(shouldAllowHighTextureTier({
      averageFps: 58,
      stableSeconds: 11,
      deviceMemoryGb: 8,
      maxTextureSize: 16384,
      saveData: false,
    })).toBe(false);
    expect(shouldAllowHighTextureTier({
      averageFps: 58,
      stableSeconds: 20,
      deviceMemoryGb: 4,
      maxTextureSize: 16384,
      saveData: false,
    })).toBe(false);
  });

  it('lets cinematic mode bypass adaptive gates but not the GPU texture limit', () => {
    expect(shouldAllowHighTextureTier({
      averageFps: 20,
      cinematic: true,
      stableSeconds: 0,
      deviceMemoryGb: 4,
      maxTextureSize: 8192,
      saveData: true,
    })).toBe(true);
    expect(shouldAllowHighTextureTier({
      averageFps: 60,
      cinematic: true,
      stableSeconds: 20,
      deviceMemoryGb: 16,
      maxTextureSize: 4096,
      saveData: false,
    })).toBe(false);
  });
});
