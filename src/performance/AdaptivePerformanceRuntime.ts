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

export const QUALITY_PROMOTION_FPS = 50;
const QUALITY_DEGRADE_FPS = 38;

export function canPromoteQuality(measuredFps: number): boolean {
  return measuredFps >= QUALITY_PROMOTION_FPS;
}

function nextLowerProfile(profile: QualityPreset): QualityPreset {
  return PROFILE_ORDER[Math.max(0, PROFILE_ORDER.indexOf(profile) - 1)];
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
  private calibrationVersion = 0;

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

  async calibrate(): Promise<QualityPreset> {
    const calibrationVersion = ++this.calibrationVersion;
    if (document.visibilityState !== 'visible') {
      this.applyProfile('Low');
      return 'Low';
    }

    let selectedProfile: QualityPreset = 'Low';
    const measurements: Partial<Record<QualityPreset, number>> = {};
    for (const candidate of PROFILE_ORDER) {
      if (calibrationVersion !== this.calibrationVersion || this.status.mode !== 'Auto') {
        return this.status.profile;
      }
      this.applyProfile(candidate);
      await this.waitFrames(2);
      const measuredFps = await this.measureFrames(450);
      measurements[candidate] = Math.round(measuredFps * 10) / 10;
      this.status.measuredFps = measurements[candidate];
      if (!canPromoteQuality(measuredFps)) {
        this.applyProfile(selectedProfile);
        break;
      }
      selectedProfile = candidate;
    }

    console.info('[Performance] Calibration complete', {
      measurements,
      profile: this.status.profile,
      renderer: this.renderer.info.render,
    });
    return this.status.profile;
  }

  setMode(mode: QualityMode): void {
    this.calibrationVersion += 1;
    this.status.mode = mode;
    if (mode === 'Auto') {
      void this.calibrate();
      return;
    }
    this.applyProfile(mode);
  }

  getSnapshot(): Record<string, unknown> {
    const lightState = Object.fromEntries(this.authoredLights
      .filter(({ light }) => EXTRA_LIGHT_NAMES.includes(light.name))
      .map(({ light }) => [light.name, light.visible]));
    return {
      ...this.status,
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

  applyProfile(profile: QualityPreset): void {
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
    this.adjustmentCooldownUntil = performance.now() + 10_000;
    this.monitorStartedAt = performance.now();
    this.monitorFrames = 0;
  }

  update(): void {
    if (this.status.mode !== 'Auto' || document.visibilityState !== 'visible') return;
    this.monitorFrames += 1;
    const now = performance.now();
    const elapsed = now - this.monitorStartedAt;
    if (elapsed < 4_000) return;

    const fps = this.monitorFrames * 1000 / elapsed;
    this.monitorStartedAt = now;
    this.monitorFrames = 0;
    if (now < this.adjustmentCooldownUntil || fps >= QUALITY_DEGRADE_FPS || this.status.profile === 'Low') return;

    const profile = nextLowerProfile(this.status.profile);
    this.applyProfile(profile);
    console.info('[Performance] Sustained frame-rate drop, reducing quality', {
      measuredFps: Math.round(fps * 10) / 10,
      profile,
    });
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

  private measureFrames(durationMs: number): Promise<number> {
    return new Promise((resolve) => {
      const startedAt = performance.now();
      let frames = 0;
      const tick = (now: number): void => {
        frames += 1;
        const elapsed = now - startedAt;
        if (elapsed >= durationMs) resolve(frames * 1000 / elapsed);
        else requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
  }
}
