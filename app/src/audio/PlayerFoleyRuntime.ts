import * as THREE from 'three';
import type { AppEvent, AppState, Store } from '../app/Store';
import type { SceneBindings } from '../scene/SceneRuntime';
import type { TrackRuntime } from './TrackRuntime';

const SOUNDS = {
  beep: new URL('../../assets/audio/Player1_Beep1.ogg', import.meta.url).href,
  discFit: new URL('../../assets/audio/Player1_CDFit1.ogg', import.meta.url).href,
  lidClose: new URL('../../assets/audio/Player1_CDLidClose1.ogg', import.meta.url).href,
  lidOpen: new URL('../../assets/audio/Player1_CDLidOpen1.ogg', import.meta.url).href,
  discReading: new URL('../../assets/audio/Player1_CDReading1.ogg', import.meta.url).href,
  discRemove: new URL('../../assets/audio/Player1_CDRemove1.ogg', import.meta.url).href,
  powerUp: new URL('../../assets/audio/Player1_PowerUP.ogg', import.meta.url).href,
  clicks: [
    new URL('../../assets/audio/Player1_Click1.ogg', import.meta.url).href,
    new URL('../../assets/audio/Player1_Click2.ogg', import.meta.url).href,
    new URL('../../assets/audio/Player1_Click3.ogg', import.meta.url).href,
  ],
} as const;

interface PlayingSound {
  stop: () => void;
}

export class PlayerFoleyRuntime {
  private readonly playerPosition = new THREE.Vector3();
  private readonly unsubscribe: () => void;
  private readingSound: PlayingSound | null = null;
  private readingGeneration = 0;

  constructor(
    private readonly store: Store,
    private readonly bindings: SceneBindings,
    private readonly audio: TrackRuntime,
  ) {
    audio.preloadSounds([
      SOUNDS.beep,
      SOUNDS.discFit,
      SOUNDS.lidClose,
      SOUNDS.lidOpen,
      SOUNDS.discReading,
      SOUNDS.discRemove,
      SOUNDS.powerUp,
      ...SOUNDS.clicks,
    ]);
    this.unsubscribe = store.subscribe((next, previous, event) => {
      this.onState(next, previous, event);
    });
  }

  dispose(): void {
    this.unsubscribe();
    this.stopReadingSound();
  }

  private onState(next: AppState, previous: AppState, event: AppEvent): void {
    if (next.discReading !== previous.discReading) {
      if (next.discReading) void this.startReadingSound();
      else this.stopReadingSound();
    }

    switch (event.type) {
      case 'POWER_PRESSED':
        this.play(next.power === 'starting' ? SOUNDS.powerUp : this.randomClick(), 0.9);
        break;
      case 'VOLUME_CHANGED':
      case 'VOLUME_BUTTON_PRESSED':
        this.play(this.randomClick(), 0.75);
        break;
      case 'SOURCE_SELECT_PRESSED':
      case 'PLAY_PAUSE_PRESSED':
      case 'TRACK_NEXT_PRESSED':
      case 'TRACK_PREVIOUS_PRESSED':
      case 'STOP_PRESSED':
        this.play(SOUNDS.beep, 0.7);
        break;
      case 'TRAY_TOGGLE_REQUESTED':
        this.play(previous.transport === 'closed' ? SOUNDS.lidOpen : SOUNDS.lidClose, 0.9);
        break;
      case 'DISC_DRAG_STARTED':
        if (previous.insertedDiscId === event.discId) this.play(SOUNDS.discRemove, 0.9);
        break;
      case 'DISC_DROPPED':
        if (next.insertedDiscId === event.discId) this.play(SOUNDS.discFit, 0.9);
        break;
      default:
        break;
    }
  }

  private play(url: string, gain: number): void {
    this.bindings.player.getWorldPosition(this.playerPosition);
    void this.audio.playSpatialSound(url, this.playerPosition, { gain });
  }

  private async startReadingSound(): Promise<void> {
    const generation = ++this.readingGeneration;
    this.bindings.player.getWorldPosition(this.playerPosition);
    const sound = await this.audio.playSpatialSound(SOUNDS.discReading, this.playerPosition, {
      gain: 0.62,
      loop: true,
    });
    if (generation !== this.readingGeneration || !this.store.getState().discReading) {
      sound.stop();
      return;
    }
    this.readingSound?.stop();
    this.readingSound = sound;
  }

  private stopReadingSound(): void {
    this.readingGeneration += 1;
    this.readingSound?.stop();
    this.readingSound = null;
  }

  private randomClick(): string {
    return SOUNDS.clicks[Math.floor(Math.random() * SOUNDS.clicks.length)];
  }
}
