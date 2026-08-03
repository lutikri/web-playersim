import { describe, expect, it } from 'vitest';
import { isSupportedTrackFile, receiverVolumeToGain } from './TrackRuntime';

describe('track file selection', () => {
  it('accepts the requested audio extensions case-insensitively', () => {
    expect(isSupportedTrackFile({ name: 'album.FLAC' })).toBe(true);
    expect(isSupportedTrackFile({ name: 'track.wav' })).toBe(true);
    expect(isSupportedTrackFile({ name: 'track.mp3' })).toBe(true);
    expect(isSupportedTrackFile({ name: 'cover.png' })).toBe(false);
  });

  it('maps the receiver 00-99 scale to a nonlinear Web Audio gain', () => {
    expect(receiverVolumeToGain(0)).toBe(0);
    expect(receiverVolumeToGain(12)).toBeGreaterThan(0.25);
    expect(receiverVolumeToGain(30)).toBe(1);
    expect(receiverVolumeToGain(99)).toBe(2);
  });
});
