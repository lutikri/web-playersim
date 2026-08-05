import { parseBlob, selectCover } from 'music-metadata';
import * as THREE from 'three';
import type { AppState, Store } from '../app/Store';
import type { PhysicsRuntime } from '../physics/PhysicsRuntime';
import type { SceneBindings, SceneRuntime } from '../scene/SceneRuntime';

const SUPPORTED_EXTENSIONS = new Set(['flac', 'mp3', 'wav']);
const SPEAKER_CROSSOVER_HZ = 2200;

interface SpeakerPlaybackNodes {
  lowPanner: PannerNode;
  highPanner: PannerNode;
  lowAnalyser: AnalyserNode;
  highAnalyser: AnalyserNode;
  lowSamples: Uint8Array<ArrayBuffer>;
  highSamples: Uint8Array<ArrayBuffer>;
  nodes: AudioNode[];
}

export function isSupportedTrackFile(file: Pick<File, 'name'>): boolean {
  const extension = file.name.split('.').pop()?.toLowerCase() ?? '';
  return SUPPORTED_EXTENSIONS.has(extension);
}

export function receiverVolumeToGain(volume: number): number {
  if (volume <= 0) return 0;
  return Math.min(2, (Math.min(99, volume) / 30) ** 1.35);
}

export function timeDomainRms(samples: Uint8Array): number {
  if (samples.length === 0) return 0;
  let sumSquares = 0;
  samples.forEach((sample) => {
    const normalized = (sample - 128) / 128;
    sumSquares += normalized * normalized;
  });
  return Math.sqrt(sumSquares / samples.length);
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
  private readonly lowPositions = [new THREE.Vector3(), new THREE.Vector3()] as const;
  private readonly highPositions = [new THREE.Vector3(), new THREE.Vector3()] as const;
  private speakerPlayback: readonly [SpeakerPlaybackNodes, SpeakerPlaybackNodes] | null = null;
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
    this.bindings.speakerLowEmitters.forEach((emitter, index) => {
      emitter.getWorldPosition(this.lowPositions[index]);
    });
    this.bindings.speakerHighEmitters.forEach((emitter, index) => {
      emitter.getWorldPosition(this.highPositions[index]);
    });
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
    this.updateSpeakerPlayback(now);
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
    source.buffer = buffer;
    source.connect(splitter);
    if (!this.masterGain) return;
    const speakerPlayback: [SpeakerPlaybackNodes, SpeakerPlaybackNodes] = [
      this.createSpeakerPlaybackNodes(context, splitter, 0, 0),
      this.createSpeakerPlaybackNodes(context, splitter, buffer.numberOfChannels > 1 ? 1 : 0, 1),
    ];
    speakerPlayback.forEach(({ lowPanner, highPanner }) => {
      lowPanner.connect(this.masterGain!);
      highPanner.connect(this.masterGain!);
    });
    this.speakerPlayback = speakerPlayback;
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

  private createSpeakerPlaybackNodes(
    context: AudioContext,
    splitter: ChannelSplitterNode,
    channel: number,
    speakerIndex: 0 | 1,
  ): SpeakerPlaybackNodes {
    const lowFilter = context.createBiquadFilter();
    lowFilter.type = 'lowpass';
    lowFilter.frequency.value = SPEAKER_CROSSOVER_HZ;
    lowFilter.Q.value = Math.SQRT1_2;
    const highFilter = context.createBiquadFilter();
    highFilter.type = 'highpass';
    highFilter.frequency.value = SPEAKER_CROSSOVER_HZ;
    highFilter.Q.value = Math.SQRT1_2;
    const lowAnalyser = context.createAnalyser();
    const highAnalyser = context.createAnalyser();
    [lowAnalyser, highAnalyser].forEach((analyser) => {
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.62;
    });
    const lowPanner = this.createPanner(context, this.lowPositions[speakerIndex]);
    const highPanner = this.createPanner(context, this.highPositions[speakerIndex]);
    splitter.connect(lowFilter, channel);
    splitter.connect(highFilter, channel);
    lowFilter.connect(lowAnalyser);
    highFilter.connect(highAnalyser);
    lowAnalyser.connect(lowPanner);
    highAnalyser.connect(highPanner);
    return {
      lowPanner,
      highPanner,
      lowAnalyser,
      highAnalyser,
      lowSamples: new Uint8Array(lowAnalyser.fftSize),
      highSamples: new Uint8Array(highAnalyser.fftSize),
      nodes: [lowFilter, highFilter, lowAnalyser, highAnalyser, lowPanner, highPanner],
    };
  }

  private updateSpeakerPlayback(now: number): void {
    const playback = this.speakerPlayback;
    if (!playback) {
      this.sceneRuntime.setSpeakerLevels([{ low: 0, high: 0 }, { low: 0, high: 0 }]);
      return;
    }
    const volumeGain = receiverVolumeToGain(this.store.getState().volume);
    const readLevels = (speaker: SpeakerPlaybackNodes, index: 0 | 1) => {
      this.setPannerPosition(speaker.lowPanner, this.lowPositions[index], now);
      this.setPannerPosition(speaker.highPanner, this.highPositions[index], now);
      speaker.lowAnalyser.getByteTimeDomainData(speaker.lowSamples);
      speaker.highAnalyser.getByteTimeDomainData(speaker.highSamples);
      return {
        low: THREE.MathUtils.clamp(timeDomainRms(speaker.lowSamples) * 5 * volumeGain, 0, 1),
        high: THREE.MathUtils.clamp(timeDomainRms(speaker.highSamples) * 7 * volumeGain, 0, 1),
      };
    };
    const levels = [readLevels(playback[0], 0), readLevels(playback[1], 1)] as const;
    this.sceneRuntime.setSpeakerLevels(levels);
  }

  private setPannerPosition(panner: PannerNode, position: THREE.Vector3, now: number): void {
    setAudioParam(panner.positionX, position.x, now);
    setAudioParam(panner.positionY, position.y, now);
    setAudioParam(panner.positionZ, position.z, now);
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
    this.speakerPlayback?.forEach((speaker) => speaker.nodes.forEach((node) => node.disconnect()));
    this.speakerPlayback = null;
    this.sceneRuntime.setSpeakerLevels([{ low: 0, high: 0 }, { low: 0, high: 0 }]);
    if (resetOffset) this.playbackOffset = 0;
  }

  private currentPlaybackSeconds(): number {
    if (!this.context || !this.source) return this.playbackOffset;
    return this.playbackOffset + this.context.currentTime - this.playbackStartedAt;
  }
}
