import * as THREE from 'three';
import { KTX2Loader } from 'three/examples/jsm/loaders/KTX2Loader.js';

export type TextureMapKind = 'baseColor' | 'emissive' | 'normal' | 'orm' | 'roughness';
export type TextureMapPaths = Partial<Record<TextureMapKind, string>>;
export type TextureMaps = Partial<Record<TextureMapKind, THREE.Texture>>;

export interface TextureTierSet {
  low: TextureMapPaths;
  medium?: TextureMapPaths;
  high?: TextureMapPaths;
}

export interface TextureStreamOptions {
  label: string;
  priority?: number;
  repeat?: number;
}

export interface HighTierCapabilities {
  averageFps?: number;
  cinematic?: boolean;
  stableSeconds?: number;
  deviceMemoryGb?: number;
  maxTextureSize: number;
  saveData?: boolean;
}

export interface TextureStreamHandle {
  readonly tier: 'low' | 'medium' | 'high';
  dispose(): void;
}

interface StreamRegistration {
  cancelled: boolean;
  currentMaps: TextureMaps;
  currentTier: 'low' | 'medium' | 'high';
  definition: TextureTierSet;
  highQueued: boolean;
  mediumSettled: boolean;
  options: TextureStreamOptions;
  apply: (maps: TextureMaps, tier: 'low' | 'medium' | 'high') => void;
}

interface UpgradeJob {
  priority: number;
  registration: StreamRegistration;
  paths: TextureMapPaths;
  tier: 'medium' | 'high';
}

export function shouldAllowHighTextureTier(capabilities: HighTierCapabilities): boolean {
  return capabilities.cinematic === true && capabilities.maxTextureSize >= 8192;
}

function disposeMaps(maps: TextureMaps): void {
  Object.values(maps).forEach((texture) => texture.dispose());
}

export class TextureStreamingRuntime {
  private readonly loader: KTX2Loader;
  private readonly textureLoader = new THREE.TextureLoader();
  private readonly registrations = new Set<StreamRegistration>();
  private readonly queue: UpgradeJob[] = [];
  private activeUpgrade = false;
  private deferredUpgradesEnabled = false;
  private disposed = false;
  private cinematicModeValue = false;

  constructor(private readonly renderer: THREE.WebGLRenderer) {
    this.loader = new KTX2Loader()
      .setTranscoderPath(`${import.meta.env.BASE_URL}basis/`)
      .detectSupport(renderer);
  }

  get cinematicMode(): boolean {
    return this.cinematicModeValue;
  }

  set cinematicMode(enabled: boolean) {
    this.cinematicModeValue = enabled;
    if (enabled) return;
    for (let index = this.queue.length - 1; index >= 0; index -= 1) {
      const job = this.queue[index];
      if (job?.tier !== 'high') continue;
      job.registration.highQueued = false;
      this.queue.splice(index, 1);
    }
  }

  async stream(
    definition: TextureTierSet,
    options: TextureStreamOptions,
    apply: (maps: TextureMaps, tier: 'low' | 'medium' | 'high') => void,
  ): Promise<TextureStreamHandle> {
    const initialMaps = await this.loadMaps(definition.low, options, false);
    const registration: StreamRegistration = {
      apply,
      cancelled: false,
      currentMaps: initialMaps,
      currentTier: 'low',
      definition,
      highQueued: false,
      mediumSettled: definition.medium === undefined,
      options,
    };
    this.registrations.add(registration);
    apply(initialMaps, 'low');
    if (definition.medium) this.enqueue(registration, definition.medium, 'medium');

    return {
      get tier() { return registration.currentTier; },
      dispose: () => {
        if (registration.cancelled) return;
        registration.cancelled = true;
        this.registrations.delete(registration);
        disposeMaps(registration.currentMaps);
      },
    };
  }

  update(deltaSeconds: number): void {
    if (this.disposed || !this.deferredUpgradesEnabled || deltaSeconds <= 0) return;
    if (this.canUseHighTier()) {
      this.registrations.forEach((registration) => {
        if (registration.cancelled
          || registration.highQueued
          || registration.currentTier !== 'medium'
          || !registration.definition.high) return;
        registration.highQueued = true;
        this.enqueue(registration, registration.definition.high, 'high');
      });
    }
    this.startNextUpgrade();
  }

  startDeferredUpgrades(): void {
    this.deferredUpgradesEnabled = true;
  }

  async prewarmMediumTier(
    onProgress?: (progress: number) => void,
    timeoutMs = 60_000,
  ): Promise<void> {
    const startedAt = performance.now();
    while (!this.disposed) {
      const mediumStreams = [...this.registrations].filter((registration) => registration.definition.medium);
      const completed = mediumStreams.filter((registration) => registration.mediumSettled).length;
      onProgress?.(mediumStreams.length === 0 ? 1 : completed / mediumStreams.length);
      if (completed === mediumStreams.length || performance.now() - startedAt >= timeoutMs) return;
      await new Promise<void>((resolve) => window.setTimeout(resolve, 50));
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.queue.length = 0;
    this.registrations.forEach((registration) => {
      registration.cancelled = true;
      disposeMaps(registration.currentMaps);
    });
    this.registrations.clear();
    this.loader.dispose();
  }

  private enqueue(
    registration: StreamRegistration,
    paths: TextureMapPaths,
    tier: 'medium' | 'high',
  ): void {
    this.queue.push({
      priority: registration.options.priority ?? 0,
      registration,
      paths,
      tier,
    });
    this.queue.sort((left, right) => right.priority - left.priority);
  }

  private startNextUpgrade(): void {
    if (this.activeUpgrade || this.queue.length === 0) return;
    const job = this.queue.shift();
    if (!job || job.registration.cancelled) {
      this.startNextUpgrade();
      return;
    }
    this.activeUpgrade = true;
    void this.runUpgrade(job).finally(() => {
      this.activeUpgrade = false;
    });
  }

  private async runUpgrade(job: UpgradeJob): Promise<void> {
    try {
      const maps = await this.loadMaps(job.paths, job.registration.options, true);
      if (this.disposed
        || job.registration.cancelled
        || (job.tier === 'high' && !this.cinematicModeValue)) {
        if (job.tier === 'high') job.registration.highQueued = false;
        disposeMaps(maps);
        return;
      }
      const previousMaps = job.registration.currentMaps;
      job.registration.apply(maps, job.tier);
      job.registration.currentMaps = maps;
      job.registration.currentTier = job.tier;
      disposeMaps(previousMaps);
      console.info(`[Texture streaming] ${job.registration.options.label}: ${job.tier}`);
    } catch (error) {
      console.warn(`[Texture streaming] Unable to upgrade ${job.registration.options.label} to ${job.tier}`, error);
    } finally {
      if (job.tier === 'medium') job.registration.mediumSettled = true;
    }
  }

  private async loadMaps(
    paths: TextureMapPaths,
    options: TextureStreamOptions,
    sequential: boolean,
  ): Promise<TextureMaps> {
    const entries = Object.entries(paths) as Array<[TextureMapKind, string]>;
    const loaded: TextureMaps = {};
    const loadEntry = async ([kind, path]: [TextureMapKind, string]): Promise<void> => {
      const texture = path.toLowerCase().endsWith('.ktx2')
        ? await this.loader.loadAsync(path)
        : await this.textureLoader.loadAsync(path);
      texture.name = `${options.label}:${kind}`;
      texture.flipY = false;
      texture.colorSpace = kind === 'baseColor' || kind === 'emissive'
        ? THREE.SRGBColorSpace
        : THREE.NoColorSpace;
      texture.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
      if (options.repeat !== undefined) {
        texture.wrapS = THREE.RepeatWrapping;
        texture.wrapT = THREE.RepeatWrapping;
        texture.repeat.setScalar(options.repeat);
      }
      texture.needsUpdate = true;
      loaded[kind] = texture;
    };
    try {
      if (sequential) {
        for (const entry of entries) await loadEntry(entry);
      } else {
        await Promise.all(entries.map(loadEntry));
      }
      return loaded;
    } catch (error) {
      disposeMaps(loaded);
      throw error;
    }
  }

  private canUseHighTier(): boolean {
    return shouldAllowHighTextureTier({
      cinematic: this.cinematicModeValue,
      maxTextureSize: this.renderer.capabilities.maxTextureSize,
    });
  }
}
