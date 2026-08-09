import { describe, expect, it } from 'vitest';
import {
  isSupportedTrackFile,
  receiverVolumeToGain,
  timeDomainRms,
  validateTrackCount,
  validateTrackDuration,
} from './TrackRuntime';

describe('track file selection', () => {
  it('accepts the requested audio extensions case-insensitively', () => {
    expect(isSupportedTrackFile({ name: 'album.FLAC' })).toBe(true);
    expect(isSupportedTrackFile({ name: 'track.wav' })).toBe(true);
    expect(isSupportedTrackFile({ name: 'track.mp3' })).toBe(true);
    expect(isSupportedTrackFile({ name: 'cover.png' })).toBe(false);
  });

  it('limits user-created discs to 20 tracks of at most 15 minutes', () => {
    expect(() => validateTrackCount(20)).not.toThrow();
    expect(() => validateTrackCount(21)).toThrow(/20 tracks/);
    expect(() => validateTrackDuration(900, 'track.flac')).not.toThrow();
    expect(() => validateTrackDuration(901, 'track.flac')).toThrow(/15 minutes/);
  });

  it('maps the receiver 00-99 scale to a nonlinear Web Audio gain', () => {
    expect(receiverVolumeToGain(0)).toBe(0);
    expect(receiverVolumeToGain(12)).toBeGreaterThan(0.25);
    expect(receiverVolumeToGain(30)).toBe(1);
    expect(receiverVolumeToGain(99)).toBe(2);
  });

  it('measures normalized waveform energy for speaker animation', () => {
    expect(timeDomainRms(new Uint8Array([128, 128, 128]))).toBe(0);
    expect(timeDomainRms(new Uint8Array([0, 255]))).toBeCloseTo(0.996, 2);
  });
});
