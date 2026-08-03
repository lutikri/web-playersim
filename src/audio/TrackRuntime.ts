import { parseBlob, selectCover } from 'music-metadata';
import * as THREE from 'three';
import type { AppState, Store } from '../app/Store';
import type { PhysicsRuntime } from '../physics/PhysicsRuntime';
import type { SceneBindings, SceneRuntime } from '../scene/SceneRuntime';

const SUPPORTED_EXTENSIONS = new Set(['flac', 'mp3', 'wav']);

export function isSupportedTrackFile(file: Pick<File, 'name'>): boolean {
  const extension = file.name.split('.').pop()?.toLowerCase() ?? '';
  return SUPPORTED_EXTENSIONS.has(extension);
}

export function receiverVolumeToGain(volume: number): number {
  if (volume <= 0) return 0;
  return Math.min(2, (Math.min(99, volume) / 30) ** 1.35);
}

function setAudioParam(param: AudioParam, value: number, time: number): void {
  param.setValueAtTime(value, time);
}

export class TrackRuntime {
  private context: AudioContext | null = null;
  private buffers: AudioBuffer[] = [];
  private readonly buffersByDisc = new Map<number, AudioBuffer[]>();
  private masterGain: GainNode | null = null;
  private foleyGain: GainNode | null = null;
  private readonly soundBuffers = new Map<string, Promise<AudioBuffer>>();
  private readonly foleySources = new Set<AudioBufferSourceNode>();
  private source: AudioBufferSourceNode | null = null;
  private playbackOffset = 0;
  private playbackStartedAt = 0;
  private trackId = 0;
  private discId = 0;
  private operationGeneration = 0;
  private progressElapsed = 0;
  private readonly unsubscribe: () => void;
  private readonly leftPosition = new THREE.Vector3();
  private readonly rightPosition = new THREE.Vector3();
  private readonly listenerPosition = new THREE.Vector3();
  private readonly listenerForward = new THREE.Vector3();
  private readonly listenerUp = new THREE.Vector3();

  constructor(
    private readonly store: Store,
    private readonly camera: THREE.Camera,
    private readonly bindings: SceneBindings,
    private readonly physics: PhysicsRuntime,
    private readonly sceneRuntime: SceneRuntime,
    private readonly onDiscSpawned: (id: number, root: THREE.Object3D) => void,
  ) {
    this.unsubscribe = store.subscribe((next, previous) => {
      if (next.volume !== previous.volume) this.applyVolume(next.volume);
      if (next.insertedDiscId !== previous.insertedDiscId) {
        this.stopSource(true);
        this.buffers = next.insertedDiscId === null
          ? []
          : this.buffersByDisc.get(next.insertedDiscId) ?? [];
        return;
      }
      if (next.currentTrackIndex !== previous.currentTrackIndex) {
        this.stopSource(true);
        if (next.playback === 'playing') void this.startSource();
        return;
      }
      if (next.playback !== previous.playback) void this.syncPlayback(next);
    });
  }

  async loadTracks(files: File[]): Promise<void> {
    if (files.length === 0 || files.some((file) => !isSupportedTrackFile(file))) {
      throw new Error('Choose one or more .flac, .wav or .mp3 files.');
    }
    const generation = ++this.operationGeneration;
    const context = this.ensureContext();
    await context.resume();
    const loaded = await Promise.all(files.map(async (file) => {
      const [arrayBuffer, metadata] = await Promise.all([
        file.arrayBuffer(),
        parseBlob(file, { duration: true }).catch(() => null),
      ]);
      const buffer = await context.decodeAudioData(arrayBuffer);
      const picture = selectCover(metadata?.common.picture);
      const cover = picture
        ? new Blob([new Uint8Array(picture.data).slice().buffer], { type: picture.format })
        : null;
      return { file, metadata, buffer, cover };
    }));
    if (generation !== this.operationGeneration) return;
    const discId = ++this.discId;
    const buffers = loaded.map((item) => item.buffer);
    const cover = loaded.find((item) => item.cover)?.cover ?? null;
    const disc = await this.sceneRuntime.spawnDisc(discId, cover);
    if (generation !== this.operationGeneration) return;
    this.buffersByDisc.set(discId, buffers);
    this.physics.registerDisc(discId, disc.root, disc.collider);
    this.onDiscSpawned(discId, disc.root);
    this.store.dispatch({
      type: 'TRACKS_LOADED',
      discId,
      tracks: loaded.map(({ file, metadata, buffer, cover: trackCover }) => ({
        id: ++this.trackId,
        title: metadata?.common.title?.trim() || file.name.replace(/\.[^.]+$/, ''),
        durationSeconds: buffer.duration,
        hasCover: trackCover !== null,
      })),
    });
  }

  update(deltaSeconds: number): void {
    const context = this.context;
    if (!context) return;
    const now = context.currentTime;
    this.bindings.speakerEmitters[0].getWorldPosition(this.leftPosition);
    this.bindings.speakerEmitters[1].getWorldPosition(this.rightPosition);
    this.camera.getWorldPosition(this.listenerPosition);
    this.camera.getWorldDirection(this.listenerForward);
    this.listenerUp.copy(this.camera.up).applyQuaternion(this.camera.getWorldQuaternion(new THREE.Quaternion())).normalize();
    const listener = context.listener;
    setAudioParam(listener.positionX, this.listenerPosition.x, now);
    setAudioParam(listener.positionY, this.listenerPosition.y, now);
    setAudioParam(listener.positionZ, this.listenerPosition.z, now);
    setAudioParam(listener.forwardX, this.listenerForward.x, now);
    setAudioParam(listener.forwardY, this.listenerForward.y, now);
    setAudioParam(listener.forwardZ, this.listenerForward.z, now);
    setAudioParam(listener.upX, this.listenerUp.x, now);
    setAudioParam(listener.upY, this.listenerUp.y, now);
    setAudioParam(listener.upZ, this.listenerUp.z, now);
    if (this.store.getState().playback === 'playing') {
      this.progressElapsed += deltaSeconds;
      if (this.progressElapsed >= 0.25) {
        this.progressElapsed = 0;
        this.store.dispatch({ type: 'PLAYBACK_PROGRESS', seconds: this.currentPlaybackSeconds() });
      }
    }
  }

  dispose(): void {
    this.operationGeneration += 1;
    this.unsubscribe();
    this.stopSource(true);
    this.foleySources.forEach((source) => source.stop());
    this.foleySources.clear();
    void this.context?.close();
  }

  preloadSounds(urls: readonly string[]): void {
    urls.forEach((url) => { void this.loadSoundBuffer(url); });
  }

  async playSpatialSound(
    url: string,
    worldPosition: THREE.Vector3,
    options: { gain?: number; loop?: boolean } = {},
  ): Promise<{ stop: () => void }> {
    const context = this.ensureContext();
    const position = worldPosition.clone();
    void context.resume();
    const buffer = await this.loadSoundBuffer(url);
    const source = context.createBufferSource();
    const gain = context.createGain();
    const panner = this.createPanner(context, position);
    source.buffer = buffer;
    source.loop = options.loop ?? false;
    gain.gain.value = options.gain ?? 1;
    source.connect(gain);
    gain.connect(panner);
    if (!this.foleyGain) throw new Error('Foley bus was not initialized.');
    panner.connect(this.foleyGain);
    this.foleySources.add(source);
    source.onended = () => this.foleySources.delete(source);
    source.start();
    return {
      stop: () => {
        if (!this.foleySources.delete(source)) return;
        source.onended = null;
        source.stop();
        source.disconnect();
      },
    };
  }

  private ensureContext(): AudioContext {
    if (!this.context) {
      this.context = new AudioContext({ latencyHint: 'interactive' });
      this.masterGain = this.context.createGain();
      this.foleyGain = this.context.createGain();
      this.foleyGain.gain.value = 0.8;
      const limiter = this.context.createDynamicsCompressor();
      limiter.threshold.value = -6;
      limiter.knee.value = 12;
      limiter.ratio.value = 4;
      limiter.attack.value = 0.003;
      limiter.release.value = 0.2;
      this.masterGain.connect(limiter);
      this.foleyGain.connect(limiter);
      limiter.connect(this.context.destination);
      this.applyVolume(this.store.getState().volume);
    }
    return this.context;
  }

  private loadSoundBuffer(url: string): Promise<AudioBuffer> {
    const existing = this.soundBuffers.get(url);
    if (existing) return existing;
    const context = this.ensureContext();
    const pending = fetch(url)
      .then((response) => {
        if (!response.ok) throw new Error(`Foley request failed (${response.status}): ${url}`);
        return response.arrayBuffer();
      })
      .then((bytes) => context.decodeAudioData(bytes));
    this.soundBuffers.set(url, pending);
    return pending;
  }

  private applyVolume(volume: number): void {
    if (!this.context || !this.masterGain) return;
    const gain = receiverVolumeToGain(volume);
    this.masterGain.gain.setTargetAtTime(gain, this.context.currentTime, 0.025);
  }

  private async syncPlayback(state: AppState): Promise<void> {
    if (state.playback === 'playing') {
      await this.startSource();
    } else {
      this.stopSource(state.playback === 'stopped');
    }
  }

  private async startSource(): Promise<void> {
    const buffer = this.buffers[this.store.getState().currentTrackIndex];
    if (!buffer || this.source) return;
    const context = this.ensureContext();
    await context.resume();
    if (this.store.getState().playback !== 'playing') return;
    const source = context.createBufferSource();
    const splitter = context.createChannelSplitter(2);
    const left = this.createPanner(context, this.leftPosition);
    const right = this.createPanner(context, this.rightPosition);
    source.buffer = buffer;
    source.connect(splitter);
    splitter.connect(left, 0);
    splitter.connect(right, buffer.numberOfChannels > 1 ? 1 : 0);
    if (!this.masterGain) return;
    left.connect(this.masterGain);
    right.connect(this.masterGain);
    this.source = source;
    this.playbackStartedAt = context.currentTime;
    source.onended = () => {
      if (this.source !== source) return;
      this.source = null;
      this.playbackOffset = 0;
      this.store.dispatch({ type: 'PLAYBACK_ENDED' });
    };
    source.start(0, Math.min(this.playbackOffset, Math.max(0, buffer.duration - 0.001)));
  }

  private createPanner(context: AudioContext, position: THREE.Vector3): PannerNode {
    const panner = context.createPanner();
    panner.panningModel = 'HRTF';
    panner.distanceModel = 'inverse';
    panner.refDistance = 0.5;
    panner.maxDistance = 20;
    panner.rolloffFactor = 1.15;
    setAudioParam(panner.positionX, position.x, context.currentTime);
    setAudioParam(panner.positionY, position.y, context.currentTime);
    setAudioParam(panner.positionZ, position.z, context.currentTime);
    return panner;
  }

  private stopSource(resetOffset: boolean): void {
    const source = this.source;
    if (source && this.context) {
      this.source = null;
      source.onended = null;
      const buffer = this.buffers[this.store.getState().currentTrackIndex];
      if (!resetOffset && buffer) {
        this.playbackOffset = (this.playbackOffset + this.context.currentTime - this.playbackStartedAt)
          % buffer.duration;
      }
      source.stop();
      source.disconnect();
    }
    if (resetOffset) this.playbackOffset = 0;
  }

  private currentPlaybackSeconds(): number {
    if (!this.context || !this.source) return this.playbackOffset;
    return this.playbackOffset + this.context.currentTime - this.playbackStartedAt;
  }
}
