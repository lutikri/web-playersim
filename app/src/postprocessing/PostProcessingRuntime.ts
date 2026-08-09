import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { BokehPass } from 'three/examples/jsm/postprocessing/BokehPass.js';
import { GTAOPass } from 'three/examples/jsm/postprocessing/GTAOPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { SMAAPass } from 'three/examples/jsm/postprocessing/SMAAPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';

export interface PostProcessingSettings {
  enabled: boolean;
  renderScale: number;
  antiAliasing: { method: 'msaa' | 'off'; msaaSamples: number; postSmaa: boolean };
  ambientOcclusion: {
    enabled: boolean;
    resolutionScale: number;
    intensity: number;
    radius: number;
    distanceExponent: number;
    thickness: number;
    distanceFallOff: number;
    scale: number;
    samples: number;
    denoiseRadius: number;
    denoiseSamples: number;
  };
  chromaticAberration: { enabled: boolean; amount: number };
  depthOfField: {
    enabled: boolean;
    autofocus: boolean;
    focus: number;
    focusSpeed: number;
    maxFocusSpeed: number;
    minDistance: number;
    maxDistance: number;
    aperture: number;
    maxBlur: number;
  };
  bloom: { enabled: boolean; strength: number; radius: number; threshold: number };
  flare: {
    enabled: boolean;
    glare: { enabled: boolean; strength: number; threshold: number; length: number; tint: string };
    ghosts: {
      enabled: boolean;
      strength: number;
      threshold: number;
      spacing: number;
      chromaticAberration: number;
      haloStrength: number;
      haloRadius: number;
      tint: string;
    };
  };
  color: {
    enabled: boolean;
    brightness: number;
    contrast: number;
    saturation: number;
    gamma: number;
    temperature: number;
    tint: number;
    vignette: { enabled: boolean; strength: number; radius: number; softness: number };
    grain: { enabled: boolean; amount: number };
  };
}

export type QualityPreset = 'Ultra' | 'High' | 'Medium' | 'Low';

export const MAX_NATIVE_RENDER_EDGE = 3840;

export function calculateCappedPixelRatio(
  width: number,
  height: number,
  devicePixelRatio: number,
  renderScale: number,
  maxNativeEdge = MAX_NATIVE_RENDER_EDGE,
): number {
  const viewportEdge = Math.max(1, width, height);
  const nativeRatio = Math.min(devicePixelRatio, 2, maxNativeEdge / viewportEdge);
  return nativeRatio * THREE.MathUtils.clamp(renderScale, 0.5, 1);
}

export type PostProcessingOverrides = {
  [Key in keyof PostProcessingSettings]?: PostProcessingSettings[Key] extends object
    ? { [NestedKey in keyof PostProcessingSettings[Key]]?: PostProcessingSettings[Key][NestedKey] extends object
      ? Partial<PostProcessingSettings[Key][NestedKey]>
      : PostProcessingSettings[Key][NestedKey] }
    : PostProcessingSettings[Key];
};

export const DEFAULT_POST_PROCESSING: PostProcessingSettings = {
  enabled: true,
  renderScale: 1,
  antiAliasing: { method: 'msaa', msaaSamples: 4, postSmaa: true },
  ambientOcclusion: {
    enabled: true,
    resolutionScale: 0.5,
    intensity: 0.65,
    radius: 0.28,
    distanceExponent: 1.6,
    thickness: 0.7,
    distanceFallOff: 1,
    scale: 1.35,
    samples: 8,
    denoiseRadius: 2,
    denoiseSamples: 4,
  },
  chromaticAberration: { enabled: true, amount: 0.001 },
  depthOfField: {
    enabled: false,
    autofocus: true,
    focus: 1.2,
    focusSpeed: 7,
    maxFocusSpeed: 1.4,
    minDistance: 0.18,
    maxDistance: 12,
    aperture: 0.025,
    maxBlur: 0.006,
  },
  bloom: { enabled: true, strength: 0.22, radius: 0.45, threshold: 0.82 },
  flare: {
    enabled: true,
    glare: { enabled: true, strength: 0.08, threshold: 0.78, length: 0.08, tint: '#e4efff' },
    ghosts: {
      enabled: true,
      strength: 0.035,
      threshold: 0.88,
      spacing: 0.72,
      chromaticAberration: 0.006,
      haloStrength: 0.16,
      haloRadius: 0.42,
      tint: '#c7dcff',
    },
  },
  color: {
    enabled: true,
    brightness: 0,
    contrast: 1.02,
    saturation: 0.94,
    gamma: 1,
    temperature: -0.02,
    tint: 0,
    vignette: { enabled: true, strength: 0.12, radius: 0.72, softness: 0.4 },
    grain: { enabled: false, amount: 0.012 },
  },
};

function cloneDefaults(): PostProcessingSettings {
  return structuredClone(DEFAULT_POST_PROCESSING);
}

function mergeSettings(target: Record<string, unknown>, source: Record<string, unknown>): void {
  Object.entries(source).forEach(([key, value]) => {
    if (!(key in target)) return;
    if (value && typeof value === 'object' && !Array.isArray(value)
      && target[key] && typeof target[key] === 'object' && !Array.isArray(target[key])) {
      mergeSettings(target[key] as Record<string, unknown>, value as Record<string, unknown>);
      return;
    }
    target[key] = value;
  });
}

export function createPostProcessingSettings(
  overrides?: PostProcessingOverrides | null,
): PostProcessingSettings {
  const settings = cloneDefaults();
  if (overrides) mergeSettings(settings as unknown as Record<string, unknown>, overrides as Record<string, unknown>);
  return settings;
}

export function limitFocusStep(current: number, target: number, maxSpeed: number, deltaSeconds: number): number {
  const maxStep = Math.max(0, maxSpeed) * Math.max(0, deltaSeconds);
  return current + THREE.MathUtils.clamp(target - current, -maxStep, maxStep);
}

const vertexShader = `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const lensShader = {
  uniforms: {
    tDiffuse: { value: null },
    bloomTexture: { value: null },
    flareEnabled: { value: 1 },
    glareEnabled: { value: 1 },
    glareStrength: { value: 0.08 },
    glareThreshold: { value: 0.78 },
    glareLength: { value: 0.08 },
    glareTint: { value: new THREE.Color() },
    ghostsEnabled: { value: 1 },
    ghostStrength: { value: 0.035 },
    ghostThreshold: { value: 0.88 },
    ghostSpacing: { value: 0.72 },
    ghostChromaticAberration: { value: 0.006 },
    haloStrength: { value: 0.16 },
    haloRadius: { value: 0.42 },
    ghostTint: { value: new THREE.Color() },
  },
  vertexShader,
  fragmentShader: `
    uniform sampler2D tDiffuse;
    uniform sampler2D bloomTexture;
    uniform float flareEnabled;
    uniform float glareEnabled;
    uniform float glareStrength;
    uniform float glareThreshold;
    uniform float glareLength;
    uniform vec3 glareTint;
    uniform float ghostsEnabled;
    uniform float ghostStrength;
    uniform float ghostThreshold;
    uniform float ghostSpacing;
    uniform float ghostChromaticAberration;
    uniform float haloStrength;
    uniform float haloRadius;
    uniform vec3 ghostTint;
    varying vec2 vUv;

    float lensLuminance(vec3 color) { return dot(color, vec3(0.2126, 0.7152, 0.0722)); }
    vec3 highlights(vec3 color, float threshold) {
      return color * smoothstep(threshold, min(1.0, threshold + 0.18), lensLuminance(color));
    }
    vec3 sampleBloom(vec2 uv) { return texture2D(bloomTexture, clamp(uv, 0.0, 1.0)).rgb; }
    vec3 sampleChromatic(vec2 uv, vec2 direction) {
      vec2 offset = direction * ghostChromaticAberration;
      return vec3(sampleBloom(uv + offset).r, sampleBloom(uv).g, sampleBloom(uv - offset).b);
    }

    void main() {
      vec4 source = texture2D(tDiffuse, vUv);
      vec3 glare = vec3(0.0);
      if (flareEnabled > 0.5 && glareEnabled > 0.5) {
        for (int i = 1; i <= 6; i++) {
          float stepAmount = float(i) / 6.0;
          float weight = (1.0 - stepAmount) * 0.24 + 0.04;
          vec2 offset = vec2(glareLength * stepAmount, 0.0);
          glare += highlights(sampleBloom(vUv + offset), glareThreshold) * weight;
          glare += highlights(sampleBloom(vUv - offset), glareThreshold) * weight;
        }
      }
      glare *= glareTint * glareStrength;

      vec3 ghosts = vec3(0.0);
      if (flareEnabled > 0.5 && ghostsEnabled > 0.5) {
        vec2 reflectedUv = vec2(1.0) - vUv;
        vec2 ghostVector = (vec2(0.5) - reflectedUv) * ghostSpacing;
        for (int i = 1; i <= 4; i++) {
          vec2 ghostUv = fract(reflectedUv + ghostVector * float(i));
          float edgeWeight = 1.0 - smoothstep(0.0, 0.72, distance(ghostUv, vec2(0.5)));
          vec2 direction = normalize(ghostUv - 0.5 + vec2(0.0001));
          ghosts += highlights(sampleChromatic(ghostUv, direction), ghostThreshold) * edgeWeight;
        }
        vec2 haloDirection = normalize(ghostVector + vec2(0.0001));
        vec2 haloUv = fract(reflectedUv + haloDirection * haloRadius);
        float haloWeight = 1.0 - smoothstep(0.0, 0.72, distance(haloUv, vec2(0.5)));
        ghosts += highlights(sampleChromatic(haloUv, haloDirection), ghostThreshold) * haloWeight * haloStrength;
      }
      ghosts *= ghostTint * ghostStrength;
      gl_FragColor = vec4(clamp(source.rgb + glare + ghosts, 0.0, 1.0), source.a);
    }
  `,
};

const colorShader = {
  uniforms: {
    tDiffuse: { value: null },
    enabled: { value: 1 },
    brightness: { value: 0 },
    contrast: { value: 1 },
    saturation: { value: 1 },
    gamma: { value: 1 },
    temperature: { value: 0 },
    tint: { value: 0 },
    vignetteStrength: { value: 0 },
    vignetteRadius: { value: 0.72 },
    vignetteSoftness: { value: 0.4 },
    grainAmount: { value: 0 },
    time: { value: 0 },
  },
  vertexShader,
  fragmentShader: `
    uniform sampler2D tDiffuse;
    uniform float enabled;
    uniform float brightness;
    uniform float contrast;
    uniform float saturation;
    uniform float gamma;
    uniform float temperature;
    uniform float tint;
    uniform float vignetteStrength;
    uniform float vignetteRadius;
    uniform float vignetteSoftness;
    uniform float grainAmount;
    uniform float time;
    varying vec2 vUv;
    float hash(vec2 p) { p += time; return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123); }
    void main() {
      vec4 source = texture2D(tDiffuse, vUv);
      if (enabled < 0.5) { gl_FragColor = source; return; }
      vec3 color = (source.rgb - 0.5) * contrast + 0.5 + brightness;
      float luma = dot(color, vec3(0.2126, 0.7152, 0.0722));
      color = mix(vec3(luma), color, saturation);
      color.r += temperature * 0.1;
      color.b -= temperature * 0.1;
      color.g += tint * 0.1;
      color = pow(max(color, vec3(0.0)), vec3(1.0 / max(gamma, 0.001)));
      float centerDistance = distance(vUv, vec2(0.5));
      float vignette = smoothstep(vignetteRadius, vignetteRadius - max(vignetteSoftness, 0.001), centerDistance);
      color *= mix(1.0 - vignetteStrength, 1.0, vignette);
      color += (hash(gl_FragCoord.xy) - 0.5) * grainAmount;
      gl_FragColor = vec4(clamp(color, 0.0, 1.0), source.a);
    }
  `,
};

const chromaticAberrationShader = {
  uniforms: {
    tDiffuse: { value: null },
    amount: { value: 0.001 },
  },
  vertexShader,
  fragmentShader: `
    uniform sampler2D tDiffuse;
    uniform float amount;
    varying vec2 vUv;
    void main() {
      vec2 offset = (vUv - vec2(0.5)) * amount;
      vec4 center = texture2D(tDiffuse, vUv);
      gl_FragColor = vec4(
        texture2D(tDiffuse, vUv + offset).r,
        center.g,
        texture2D(tDiffuse, vUv - offset).b,
        center.a
      );
    }
  `,
};

export class PostProcessingRuntime {
  readonly settings: PostProcessingSettings;
  readonly diagnostics = {
    fps: 0,
    frameMs: 0,
    drawCalls: 0,
    triangles: 0,
    textures: 0,
    programs: 0,
    renderSize: '0 x 0',
  };
  private composer!: EffectComposer;
  private gtaoPass!: GTAOPass;
  private bokehPass!: BokehPass;
  private bloomPass!: UnrealBloomPass;
  private lensPass!: ShaderPass;
  private chromaticAberrationPass!: ShaderPass;
  private colorPass!: ShaderPass;
  private smaaPass!: SMAAPass;
  private elapsedSeconds = 0;
  private width = window.innerWidth;
  private height = window.innerHeight;
  private ambientOcclusionKey = '';
  private readonly autofocusRaycaster = new THREE.Raycaster();
  private readonly autofocusPoint = new THREE.Vector2();
  private autofocusDistance = 1.2;
  private autofocusTargetDistance = 1.2;
  private autofocusElapsed = 0;
  private diagnosticsStartedAt = performance.now();
  private diagnosticsFrames = 0;
  private diagnosticsDrawCalls = 0;
  private diagnosticsTriangles = 0;
  private readonly drawingBufferSize = new THREE.Vector2();
  private readonly authoredSettings: PostProcessingSettings;

  constructor(
    private readonly renderer: THREE.WebGLRenderer,
    private readonly scene: THREE.Scene,
    private readonly camera: THREE.Camera,
    overrides?: PostProcessingOverrides | null,
  ) {
    this.settings = createPostProcessingSettings(overrides);
    this.authoredSettings = structuredClone(this.settings);
    this.autofocusDistance = this.settings.depthOfField.focus;
    this.autofocusTargetDistance = this.autofocusDistance;
    this.renderer.info.autoReset = false;
    this.applyPixelRatio();
    this.buildPipeline();
  }

  rebuild(): void {
    this.disposePipeline();
    this.buildPipeline();
  }

  setRenderScale(scale: number): void {
    this.settings.renderScale = THREE.MathUtils.clamp(scale, 0.5, 1);
    this.resize(this.width, this.height);
  }

  setAutofocusPoint(point: THREE.Vector2): void {
    this.autofocusPoint.copy(point);
  }

  get isAmbientOcclusionPassEnabled(): boolean {
    return this.gtaoPass?.enabled ?? false;
  }

  get activePasses(): Record<string, boolean> {
    return {
      gtao: this.gtaoPass?.enabled ?? false,
      depthOfField: this.bokehPass?.enabled ?? false,
      bloom: this.bloomPass?.enabled ?? false,
      flare: this.lensPass?.enabled ?? false,
      chromaticAberration: this.chromaticAberrationPass?.enabled ?? false,
      color: this.colorPass?.enabled ?? false,
      smaa: this.smaaPass?.enabled ?? false,
    };
  }

  applyQualityPreset(preset: QualityPreset): void {
    mergeSettings(
      this.settings as unknown as Record<string, unknown>,
      this.authoredSettings as unknown as Record<string, unknown>,
    );
    const { ambientOcclusion, antiAliasing, bloom, chromaticAberration, depthOfField, flare } = this.settings;
    if (preset === 'Ultra') {
      // Ultra is the authored level configuration, including its exact effect values.
    } else if (preset === 'High') {
      this.settings.renderScale = 0.85;
      Object.assign(antiAliasing, { method: 'msaa', msaaSamples: 2, postSmaa: true });
      ambientOcclusion.enabled = false;
      bloom.enabled = true;
      flare.enabled = true;
      flare.glare.enabled = true;
      flare.ghosts.enabled = false;
      chromaticAberration.enabled = true;
    } else if (preset === 'Medium') {
      this.settings.renderScale = 0.7;
      Object.assign(antiAliasing, { method: 'off', msaaSamples: 0, postSmaa: true });
      ambientOcclusion.enabled = false;
      bloom.enabled = false;
      flare.enabled = false;
      chromaticAberration.enabled = false;
      depthOfField.enabled = false;
    } else {
      this.settings.enabled = false;
      this.settings.renderScale = 0.55;
      Object.assign(antiAliasing, { method: 'off', msaaSamples: 0, postSmaa: false });
      ambientOcclusion.enabled = false;
      bloom.enabled = false;
      flare.enabled = false;
      chromaticAberration.enabled = false;
      depthOfField.enabled = false;
    }
    this.rebuild();
  }

  private buildPipeline(): void {
    // Every pass is a new instance after a quality change, so cached sync keys
    // must not suppress applying settings to the replacement pass.
    this.ambientOcclusionKey = '';
    const renderTarget = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType });
    const requestedSamples = this.settings.antiAliasing.method === 'msaa'
      ? this.settings.antiAliasing.msaaSamples
      : 0;
    renderTarget.samples = this.renderer.capabilities.isWebGL2
      ? Math.min(Math.max(0, requestedSamples), this.renderer.capabilities.maxSamples)
      : 0;
    this.composer = new EffectComposer(this.renderer, renderTarget);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.gtaoPass = new GTAOPass(this.scene, this.camera, 1, 1);
    this.gtaoPass.output = GTAOPass.OUTPUT.Default;
    this.gtaoPass.normalMaterial.side = THREE.DoubleSide;
    this.composer.addPass(this.gtaoPass);
    this.bokehPass = new BokehPass(this.scene, this.camera, {
      focus: this.settings.depthOfField.focus,
      aperture: this.settings.depthOfField.aperture,
      maxblur: this.settings.depthOfField.maxBlur,
    });
    this.composer.addPass(this.bokehPass);
    this.bloomPass = new UnrealBloomPass(new THREE.Vector2(1, 1), 0, 0, 1);
    this.composer.addPass(this.bloomPass);
    this.lensPass = new ShaderPass(lensShader);
    this.composer.addPass(this.lensPass);
    this.chromaticAberrationPass = new ShaderPass(chromaticAberrationShader);
    this.composer.addPass(this.chromaticAberrationPass);
    this.colorPass = new ShaderPass(colorShader);
    this.composer.addPass(this.colorPass);
    this.smaaPass = new SMAAPass();
    this.composer.addPass(this.smaaPass);
    this.composer.addPass(new OutputPass());
    this.resize(window.innerWidth, window.innerHeight);
    this.syncSettings();
  }

  render(deltaSeconds: number): void {
    this.renderer.info.reset();
    if (!this.settings.enabled) {
      this.renderer.render(this.scene, this.camera);
      this.updateDiagnostics();
      return;
    }
    this.elapsedSeconds += deltaSeconds;
    this.updateAutofocus(deltaSeconds);
    this.syncSettings();
    this.colorPass.uniforms.time.value = this.elapsedSeconds;
    this.composer.render(deltaSeconds);
    this.updateDiagnostics();
  }

  resize(width: number, height: number): void {
    this.width = width;
    this.height = height;
    this.applyPixelRatio();
    this.renderer.setSize(width, height, false);
    const pixelRatio = this.renderer.getPixelRatio();
    this.composer.setPixelRatio(pixelRatio);
    this.composer.setSize(width, height);
    this.resizeAmbientOcclusion();
  }

  dispose(): void {
    this.disposePipeline();
  }

  private disposePipeline(): void {
    this.composer.passes.forEach((pass) => pass.dispose?.());
    this.composer.dispose();
  }

  private syncSettings(): void {
    const { ambientOcclusion, bloom, chromaticAberration, color, depthOfField, flare } = this.settings;
    const ambientOcclusionKey = JSON.stringify(ambientOcclusion);
    if (ambientOcclusionKey !== this.ambientOcclusionKey) {
      this.gtaoPass.enabled = ambientOcclusion.enabled;
      this.gtaoPass.blendIntensity = ambientOcclusion.intensity;
      this.gtaoPass.updateGtaoMaterial({
        radius: ambientOcclusion.radius,
        distanceExponent: ambientOcclusion.distanceExponent,
        thickness: ambientOcclusion.thickness,
        distanceFallOff: ambientOcclusion.distanceFallOff,
        scale: ambientOcclusion.scale,
        samples: ambientOcclusion.samples,
      });
      this.gtaoPass.updatePdMaterial({
        radius: ambientOcclusion.denoiseRadius,
        samples: ambientOcclusion.denoiseSamples,
      });
      this.ambientOcclusionKey = ambientOcclusionKey;
      this.resizeAmbientOcclusion();
    }
    this.bokehPass.enabled = depthOfField.enabled;
    const bokehUniforms = this.bokehPass.uniforms as {
      focus: THREE.IUniform<number>;
      aperture: THREE.IUniform<number>;
      maxblur: THREE.IUniform<number>;
    };
    bokehUniforms.focus.value = depthOfField.autofocus ? this.autofocusDistance : depthOfField.focus;
    bokehUniforms.aperture.value = depthOfField.aperture;
    bokehUniforms.maxblur.value = depthOfField.maxBlur;
    const lensEnabled = flare.enabled
      && ((flare.glare.enabled && flare.glare.strength > 0) || (flare.ghosts.enabled && flare.ghosts.strength > 0));
    this.bloomPass.enabled = bloom.enabled || lensEnabled;
    this.bloomPass.strength = bloom.enabled ? bloom.strength : 0;
    this.bloomPass.radius = bloom.radius;
    this.bloomPass.threshold = bloom.threshold;
    this.lensPass.uniforms.bloomTexture.value = this.bloomPass.renderTargetsHorizontal[0].texture;
    this.lensPass.enabled = lensEnabled;
    this.lensPass.uniforms.flareEnabled.value = flare.enabled ? 1 : 0;
    this.lensPass.uniforms.glareEnabled.value = flare.glare.enabled ? 1 : 0;
    this.lensPass.uniforms.glareStrength.value = flare.glare.strength;
    this.lensPass.uniforms.glareThreshold.value = flare.glare.threshold;
    this.lensPass.uniforms.glareLength.value = flare.glare.length;
    this.lensPass.uniforms.glareTint.value.set(flare.glare.tint);
    this.lensPass.uniforms.ghostsEnabled.value = flare.ghosts.enabled ? 1 : 0;
    this.lensPass.uniforms.ghostStrength.value = flare.ghosts.strength;
    this.lensPass.uniforms.ghostThreshold.value = flare.ghosts.threshold;
    this.lensPass.uniforms.ghostSpacing.value = flare.ghosts.spacing;
    this.lensPass.uniforms.ghostChromaticAberration.value = flare.ghosts.chromaticAberration;
    this.lensPass.uniforms.haloStrength.value = flare.ghosts.haloStrength;
    this.lensPass.uniforms.haloRadius.value = flare.ghosts.haloRadius;
    this.lensPass.uniforms.ghostTint.value.set(flare.ghosts.tint);
    this.chromaticAberrationPass.enabled = chromaticAberration.enabled;
    this.chromaticAberrationPass.uniforms.amount.value = chromaticAberration.amount;
    this.smaaPass.enabled = this.settings.antiAliasing.postSmaa;
    this.colorPass.enabled = color.enabled;
    this.colorPass.uniforms.enabled.value = color.enabled ? 1 : 0;
    this.colorPass.uniforms.brightness.value = color.brightness;
    this.colorPass.uniforms.contrast.value = color.contrast;
    this.colorPass.uniforms.saturation.value = color.saturation;
    this.colorPass.uniforms.gamma.value = color.gamma;
    this.colorPass.uniforms.temperature.value = color.temperature;
    this.colorPass.uniforms.tint.value = color.tint;
    this.colorPass.uniforms.vignetteStrength.value = color.vignette.enabled ? color.vignette.strength : 0;
    this.colorPass.uniforms.vignetteRadius.value = color.vignette.radius;
    this.colorPass.uniforms.vignetteSoftness.value = color.vignette.softness;
    this.colorPass.uniforms.grainAmount.value = color.grain.enabled ? color.grain.amount : 0;
  }

  private resizeAmbientOcclusion(): void {
    if (!this.gtaoPass) return;
    const scale = THREE.MathUtils.clamp(this.settings.ambientOcclusion.resolutionScale, 0.25, 1);
    const pixelRatio = this.renderer.getPixelRatio();
    this.gtaoPass.setSize(
      Math.max(1, Math.round(this.width * pixelRatio * scale)),
      Math.max(1, Math.round(this.height * pixelRatio * scale)),
    );
  }

  private updateAutofocus(deltaSeconds: number): void {
    const settings = this.settings.depthOfField;
    if (!settings.enabled || !settings.autofocus) {
      this.autofocusDistance = settings.focus;
      this.autofocusTargetDistance = settings.focus;
      this.autofocusElapsed = 0;
      return;
    }
    this.autofocusElapsed += deltaSeconds;
    if (this.autofocusElapsed >= 0.1) {
      this.autofocusElapsed = 0;
      this.autofocusRaycaster.setFromCamera(this.autofocusPoint, this.camera);
      this.autofocusRaycaster.far = settings.maxDistance;
      const hit = this.autofocusRaycaster.intersectObjects(this.scene.children, true).find((intersection) => {
        const object = intersection.object;
        if (!(object instanceof THREE.Mesh) || object.material instanceof THREE.MeshBasicMaterial) return false;
        if (/^(?:U[BC]X)_/.test(object.name)) return false;
        let ancestor: THREE.Object3D | null = object;
        while (ancestor) {
          if (!ancestor.visible) return false;
          ancestor = ancestor.parent;
        }
        return true;
      });
      if (hit) {
        this.autofocusTargetDistance = THREE.MathUtils.clamp(
          hit.distance,
          settings.minDistance,
          settings.maxDistance,
        );
      }
    }
    const dampedDistance = THREE.MathUtils.damp(
      this.autofocusDistance,
      this.autofocusTargetDistance,
      settings.focusSpeed,
      deltaSeconds,
    );
    this.autofocusDistance = limitFocusStep(
      this.autofocusDistance,
      dampedDistance,
      settings.maxFocusSpeed,
      deltaSeconds,
    );
  }

  private applyPixelRatio(): void {
    this.renderer.setPixelRatio(calculateCappedPixelRatio(
      this.width,
      this.height,
      window.devicePixelRatio,
      this.settings.renderScale,
    ));
  }

  private updateDiagnostics(): void {
    this.diagnosticsFrames += 1;
    this.diagnosticsDrawCalls += this.renderer.info.render.calls;
    this.diagnosticsTriangles += this.renderer.info.render.triangles;
    const now = performance.now();
    const elapsed = now - this.diagnosticsStartedAt;
    if (elapsed < 750) return;
    this.diagnostics.fps = Math.round((this.diagnosticsFrames * 1000 / elapsed) * 10) / 10;
    this.diagnostics.frameMs = Math.round((elapsed / this.diagnosticsFrames) * 100) / 100;
    this.diagnostics.drawCalls = Math.round(this.diagnosticsDrawCalls / this.diagnosticsFrames);
    this.diagnostics.triangles = Math.round(this.diagnosticsTriangles / this.diagnosticsFrames);
    this.diagnostics.textures = this.renderer.info.memory.textures;
    this.diagnostics.programs = this.renderer.info.programs?.length ?? 0;
    this.renderer.getDrawingBufferSize(this.drawingBufferSize);
    this.diagnostics.renderSize = `${this.drawingBufferSize.x} x ${this.drawingBufferSize.y}`;
    this.diagnosticsFrames = 0;
    this.diagnosticsDrawCalls = 0;
    this.diagnosticsTriangles = 0;
    this.diagnosticsStartedAt = now;
  }
}
