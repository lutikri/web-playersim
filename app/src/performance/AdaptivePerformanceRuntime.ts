import * as THREE from 'three';
import type { PostProcessingRuntime, QualityPreset } from '../postprocessing/PostProcessingRuntime';

export type QualityMode = 'Auto' | QualityPreset;

const PROFILE_ORDER: QualityPreset[] = ['Low', 'Medium', 'High', 'Ultra'];
const EXTRA_LIGHT_NAMES = ['Fill Point', 'Point Light 1'];

interface AuthoredLightState {
  light: THREE.Light;
  visible: boolean;
  castShadow: boolean;
}

export const QUALITY_PROMOTION_FPS = 55;
const QUALITY_DEGRADE_FPS = 38;
const QUALITY_MEASUREMENT_MS = 3_000;
const MEASUREMENT_STALL_MS = 1_000;
const CALIBRATION_MEASUREMENT_MS = 1_200;

export function canPromoteQuality(measuredFps: number): boolean {
  return measuredFps >= QUALITY_PROMOTION_FPS;
}

function nextLowerProfile(profile: QualityPreset): QualityPreset {
  return PROFILE_ORDER[Math.max(0, PROFILE_ORDER.indexOf(profile) - 1)];
}

function nextHigherProfile(profile: QualityPreset): QualityPreset {
  return PROFILE_ORDER[Math.min(PROFILE_ORDER.length - 1, PROFILE_ORDER.indexOf(profile) + 1)];
}

function isProfileAllowed(profile: QualityPreset, ceiling: QualityPreset): boolean {
  return PROFILE_ORDER.indexOf(profile) <= PROFILE_ORDER.indexOf(ceiling);
}

export class AdaptivePerformanceRuntime {
  readonly status = {
    mode: 'Auto' as QualityMode,
    profile: 'Low' as QualityPreset,
    measuredFps: 0,
  };

  private readonly authoredLights: AuthoredLightState[] = [];
  private monitorStartedAt = performance.now();
  private monitorFrames = 0;
  private adjustmentCooldownUntil = 0;
  private monitoringEnabled = false;
  private lastMonitorFrameAt = performance.now();
  private autoProfileCeiling: QualityPreset = 'Ultra';

  constructor(
    private readonly renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
    private readonly postProcessing: PostProcessingRuntime,
  ) {
    scene.traverse((object) => {
      if (object instanceof THREE.Light) {
        this.authoredLights.push({
          light: object,
          visible: object.visible,
          castShadow: object.castShadow,
        });
      }
    });
    // Never expose the authored, most expensive pipeline while the loading UI is interactive.
    this.applyProfile('Low');
  }

  startAutoTuning(): void {
    this.status.mode = 'Auto';
    this.monitoringEnabled = true;
    this.autoProfileCeiling = 'Ultra';
    this.applyProfile('Low', 1_000);
    console.info('[Performance] Auto tuning started at Low using rendered scene frames');
  }

  async calibrateVisibleScene(onProgress: (progress: number) => void = () => undefined): Promise<QualityPreset> {
    this.status.mode = 'Auto';
    this.monitoringEnabled = false;
    this.autoProfileCeiling = 'Ultra';
    let selectedProfile: QualityPreset = 'Low';
    const measurements: Partial<Record<QualityPreset, number>> = {};

    for (let index = 0; index < PROFILE_ORDER.length; index += 1) {
      const candidate = PROFILE_ORDER[index];
      this.applyProfile(candidate, 0);
      onProgress(index / PROFILE_ORDER.length);
      await this.waitFrames(8);
      const measuredFps = await this.measureRenderedFrames(CALIBRATION_MEASUREMENT_MS);
      measurements[candidate] = Math.round(measuredFps * 10) / 10;
      this.status.measuredFps = measurements[candidate];
      if (!canPromoteQuality(measuredFps)) break;
      selectedProfile = candidate;
    }

    this.autoProfileCeiling = selectedProfile;
    this.applyProfile(selectedProfile, 4_000);
    this.monitoringEnabled = true;
    onProgress(1);
    console.info('[Performance] Visible-scene calibration complete', {
      measurements,
      profile: selectedProfile,
      ceiling: this.autoProfileCeiling,
      renderer: this.renderer.info.render,
    });
    return selectedProfile;
  }

  setMode(mode: QualityMode): void {
    this.status.mode = mode;
    if (mode === 'Auto') {
      this.startAutoTuning();
      return;
    }
    this.monitoringEnabled = false;
    this.applyProfile(mode);
  }

  getSnapshot(): Record<string, unknown> {
    const lightState = Object.fromEntries(this.authoredLights
      .filter(({ light }) => EXTRA_LIGHT_NAMES.includes(light.name))
      .map(({ light }) => [light.name, light.visible]));
    return {
      ...this.status,
      autoProfileCeiling: this.autoProfileCeiling,
      renderScale: this.postProcessing.settings.renderScale,
      postProcessing: this.postProcessing.settings.enabled,
      ambientOcclusion: this.postProcessing.settings.ambientOcclusion.enabled,
      gtaoPassEnabled: this.postProcessing.isAmbientOcclusionPassEnabled,
      bloom: this.postProcessing.settings.bloom.enabled,
      activePasses: this.postProcessing.activePasses,
      antiAliasing: { ...this.postProcessing.settings.antiAliasing },
      shadows: this.renderer.shadowMap.enabled,
      extraLights: lightState,
    };
  }

  applyProfile(profile: QualityPreset, cooldownMs = 10_000): void {
    this.status.profile = profile;
    this.postProcessing.applyQualityPreset(profile);

    const shadowsEnabled = profile === 'Ultra' || profile === 'High';
    const extraLightsEnabled = profile === 'Ultra' || profile === 'High';
    this.renderer.shadowMap.enabled = shadowsEnabled;
    this.renderer.shadowMap.needsUpdate = shadowsEnabled;

    this.authoredLights.forEach(({ light, visible, castShadow }) => {
      const isExtraLight = EXTRA_LIGHT_NAMES.includes(light.name);
      light.visible = isExtraLight ? visible && extraLightsEnabled : visible;
      light.castShadow = shadowsEnabled && castShadow;
    });
    this.adjustmentCooldownUntil = performance.now() + cooldownMs;
    this.monitorStartedAt = performance.now();
    this.lastMonitorFrameAt = this.monitorStartedAt;
    this.monitorFrames = 0;
  }

  update(): void {
    if (!this.monitoringEnabled || this.status.mode !== 'Auto' || document.visibilityState !== 'visible') return;
    const now = performance.now();
    if (now - this.lastMonitorFrameAt > MEASUREMENT_STALL_MS) {
      this.monitorStartedAt = now;
      this.monitorFrames = 0;
      this.lastMonitorFrameAt = now;
      console.info('[Performance] Ignoring interrupted measurement window');
      return;
    }
    this.lastMonitorFrameAt = now;
    this.monitorFrames += 1;
    const elapsed = now - this.monitorStartedAt;
    if (elapsed < QUALITY_MEASUREMENT_MS) return;

    const fps = this.monitorFrames * 1000 / elapsed;
    this.monitorStartedAt = now;
    this.monitorFrames = 0;
    const measuredFps = Math.round(fps * 10) / 10;
    this.status.measuredFps = measuredFps;
    if (now < this.adjustmentCooldownUntil) return;

    if (fps < QUALITY_DEGRADE_FPS && this.status.profile !== 'Low') {
      const profile = nextLowerProfile(this.status.profile);
      this.autoProfileCeiling = profile;
      this.applyProfile(profile, 4_000);
      console.info('[Performance] Sustained frame-rate drop, reducing quality', {
        measuredFps,
        profile,
        ceiling: this.autoProfileCeiling,
      });
      return;
    }
    if (canPromoteQuality(fps) && this.status.profile !== 'Ultra') {
      const profile = nextHigherProfile(this.status.profile);
      if (!isProfileAllowed(profile, this.autoProfileCeiling)) return;
      this.applyProfile(profile, QUALITY_MEASUREMENT_MS);
      console.info('[Performance] Sustained frame rate, increasing quality', { measuredFps, profile });
    }
  }

  private waitFrames(frameCount: number): Promise<void> {
    return new Promise((resolve) => {
      let remaining = frameCount;
      const tick = (): void => {
        remaining -= 1;
        if (remaining <= 0) resolve();
        else requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
  }

  private measureRenderedFrames(durationMs: number): Promise<number> {
    return new Promise((resolve) => {
      let startedAt = performance.now();
      let previousFrameAt = startedAt;
      let frames = 0;
      const tick = (now: number): void => {
        if (now - previousFrameAt > MEASUREMENT_STALL_MS) {
          startedAt = now;
          frames = 0;
        }
        previousFrameAt = now;
        frames += 1;
        const elapsed = now - startedAt;
        if (elapsed >= durationMs) resolve(frames * 1000 / elapsed);
        else requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
  }
}
