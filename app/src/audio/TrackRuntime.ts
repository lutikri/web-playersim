import { parseBlob, selectCover } from 'music-metadata';
import * as THREE from 'three';
import type { AppState, Store } from '../app/Store';
import type { PhysicsRuntime } from '../physics/PhysicsRuntime';
import type { SceneBindings, SceneRuntime } from '../scene/SceneRuntime';

const SUPPORTED_EXTENSIONS = new Set(['flac', 'mp3', 'wav']);
export const MAX_USER_TRACKS = 20;
export const MAX_TRACK_DURATION_SECONDS = 15 * 60;
const SPEAKER_CROSSOVER_HZ = 2200;
const BUNDLED_DISCS = [
  {
    title: 'CIRCUITS',
    artist: 'Alexander Nakarada',
    durationSeconds: 349.875011,
    marker: 'PF_ExampleDisk1',
    url: new URL('../../assets/audio/Circuits.ogg', import.meta.url).href,
  },
  {
    title: 'AFTER HOURS',
    artist: 'Surprising_Media',
    durationSeconds: 634.056,
    marker: 'PF_ExampleDisk2',
    url: new URL('../../assets/audio/AfterHours.ogg', import.meta.url).href,
  },
] as const;

interface TrackPlaybackSource {
  buffer?: AudioBuffer;
  url?: string;
}

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

export function validateTrackCount(count: number): void {
  if (count > MAX_USER_TRACKS) throw new Error(`A disc can contain up to ${MAX_USER_TRACKS} tracks.`);
}

export function validateTrackDuration(durationSeconds: number, fileName: string): void {
  if (Number.isFinite(durationSeconds) && durationSeconds > MAX_TRACK_DURATION_SECONDS) {
    throw new Error(`${fileName} is longer than 15 minutes.`);
  }
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

function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error('Unable to create generated disc artwork.'));
    }, 'image/png');
  });
}

async function createFallbackCover(title: string, trackCount: number): Promise<Blob> {
  const canvas = document.createElement('canvas');
  canvas.width = 1024;
  canvas.height = 1024;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Unable to create generated disc artwork canvas.');
  context.fillStyle = '#030303';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.save();
  context.translate(512, 280);
  context.rotate(-0.055);
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.fillStyle = '#ebe8de';
  const words = title.trim().toUpperCase().split(/\s+/).filter(Boolean);
  const lines = words.length > 1 ? words : [words[0] ?? 'UNTITLED'];
  const fontSize = lines.some((line) => line.length > 11) ? 76 : 96;
  context.font = `600 ${fontSize}px "Segoe Print", "Bradley Hand", cursive`;
  const lineHeight = fontSize * 1.18;
  const startY = -((lines.length - 1) * lineHeight) * 0.5;
  lines.forEach((line, index) => context.fillText(line, 0, startY + index * lineHeight, 690));
  if (trackCount > 1) {
    context.font = '500 35px "Segoe Print", "Bradley Hand", cursive';
    context.globalAlpha = 0.72;
    context.fillText(`${trackCount} TRACKS`, 0, startY + lines.length * lineHeight + 28);
  }
  context.restore();
  return canvasToBlob(canvas);
}

export class TrackRuntime {
  private context: AudioContext | null = null;
  private tracks: TrackPlaybackSource[] = [];
  private readonly tracksByDisc = new Map<number, TrackPlaybackSource[]>();
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
        this.tracks = next.insertedDiscId === null
          ? []
          : this.tracksByDisc.get(next.insertedDiscId) ?? [];
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
    validateTrackCount(files.length);
    const generation = ++this.operationGeneration;
    const context = this.ensureContext();
    await context.resume();
    const loaded = [];
    for (const file of files) {
      const metadata = await parseBlob(file, { duration: true }).catch(() => null);
      validateTrackDuration(metadata?.format.duration ?? 0, file.name);
      const arrayBuffer = await file.arrayBuffer();
      const buffer = await context.decodeAudioData(arrayBuffer);
      validateTrackDuration(buffer.duration, file.name);
      const picture = selectCover(metadata?.common.picture);
      const cover = picture
        ? new Blob([new Uint8Array(picture.data).slice().buffer], { type: picture.format })
        : null;
      loaded.push({ file, metadata, buffer, cover });
      if (generation !== this.operationGeneration) return;
    }
    if (generation !== this.operationGeneration) return;
    const discId = ++this.discId;
    const titles = loaded.map(({ file, metadata }) => metadata?.common.title?.trim() || file.name.replace(/\.[^.]+$/, ''));
    const artists = loaded.map(({ metadata }) => metadata?.common.artist?.trim());
    const embeddedCover = loaded.find((item) => item.cover)?.cover ?? null;
    const cover = embeddedCover ?? await createFallbackCover(titles[0] ?? 'UNTITLED', loaded.length);
    const disc = await this.sceneRuntime.spawnDisc(discId, cover);
    if (generation !== this.operationGeneration) return;
    this.tracksByDisc.set(discId, loaded.map((item) => ({ buffer: item.buffer })));
    this.physics.registerDisc(discId, disc.root, disc.collider);
    this.onDiscSpawned(discId, disc.root);
    this.store.dispatch({
      type: 'TRACKS_LOADED',
      discId,
      tracks: loaded.map(({ buffer, cover: trackCover }, index) => ({
        id: ++this.trackId,
        title: titles[index],
        artist: artists[index],
        durationSeconds: buffer.duration,
        hasCover: trackCover !== null,
      })),
    });
  }

  async loadBundledDiscs(): Promise<void> {
    for (const definition of BUNDLED_DISCS) {
      const discId = ++this.discId;
      const cover = await createFallbackCover(definition.title, 1);
      const disc = await this.sceneRuntime.spawnDisc(discId, cover, definition.marker);
      this.tracksByDisc.set(discId, [{ url: definition.url }]);
      this.physics.registerDisc(discId, disc.root, disc.collider);
      this.onDiscSpawned(discId, disc.root);
      this.store.dispatch({
        type: 'TRACKS_LOADED',
        discId,
        tracks: [{
          id: ++this.trackId,
          title: definition.title,
          artist: definition.artist,
          durationSeconds: definition.durationSeconds,
          hasCover: false,
        }],
      });
    }
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
    const requestedState = this.store.getState();
    const requestedTrackIndex = requestedState.currentTrackIndex;
    const requestedDiscId = requestedState.insertedDiscId;
    const track = this.tracks[requestedTrackIndex];
    if (!track || this.source) return;
    const context = this.ensureContext();
    await context.resume();
    const buffer = track.buffer ?? (track.url ? await this.loadSoundBuffer(track.url) : null);
    const currentState = this.store.getState();
    if (!buffer
      || currentState.playback !== 'playing'
      || currentState.insertedDiscId !== requestedDiscId
      || currentState.currentTrackIndex !== requestedTrackIndex
      || this.source) return;
    track.buffer = buffer;
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
      const buffer = source.buffer;
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
