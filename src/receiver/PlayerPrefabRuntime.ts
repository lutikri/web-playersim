import * as THREE from 'three';
import type { AppState, InputSource, Store } from '../app/Store';
import type { StudioEnvironmentRuntime } from '../scene/StudioEnvironmentRuntime';
import type { TextureMaps, TextureStreamingRuntime, TextureStreamHandle } from '../scene/TextureStreamingRuntime';
import { drawDotMatrixText, measureDotMatrixText, type DotMatrixTextStyle } from './DotMatrixDisplay';

const TEXTURES = {
  player: {
    low: {
      baseColor: new URL('../../assets/runtime-textures/T_Player1_BaseColor_1K.ktx2', import.meta.url).href,
      normal: new URL('../../assets/runtime-textures/T_Player1_Normal_1K.ktx2', import.meta.url).href,
      orm: new URL('../../assets/runtime-textures/T_Player1_ORM_1K.ktx2', import.meta.url).href,
    },
    medium: {
      baseColor: new URL('../../assets/runtime-textures/T_Player1_BaseColor_4K.ktx2', import.meta.url).href,
      normal: new URL('../../assets/runtime-textures/T_Player1_Normal_4K.ktx2', import.meta.url).href,
      orm: new URL('../../assets/runtime-textures/T_Player1_ORM_4K.ktx2', import.meta.url).href,
    },
    high: {
      baseColor: new URL('../../assets/runtime-textures/T_Player1_BaseColor_8K.ktx2', import.meta.url).href,
      normal: new URL('../../assets/runtime-textures/T_Player1_Normal_8K.ktx2', import.meta.url).href,
      orm: new URL('../../assets/runtime-textures/T_Player1_ORM_8K.ktx2', import.meta.url).href,
    },
  },
  controlBar: {
    low: {
      emissive: new URL('../../assets/runtime-textures/T_ControlBar1_1K.ktx2', import.meta.url).href,
    },
  },
} as const;

const POWER_BLACKOUT_SECONDS = 0.3;
const POWER_VOLUME_SECONDS = 1;
const POWER_FINAL_BLACKOUT_SECONDS = 0.3;
const POWER_STARTUP_SECONDS = POWER_BLACKOUT_SECONDS + POWER_VOLUME_SECONDS + POWER_FINAL_BLACKOUT_SECONDS;
const CD_READING_WITH_DISC_SECONDS = 6;
const CD_READING_EMPTY_SECONDS = 2;
const CD_BLINK_SECONDS = 0.35;
const LID_TRANSITION_SECONDS = 0.7;
const LID_OPEN_ROTATION = Math.PI;
const LID_LOCAL_AXIS = new THREE.Vector3(0, 1, 0);
const BUTTON_PRESS_TRAVEL = 0.0006;
const SCREEN_WIDTH = 530;
const SCREEN_HEIGHT = 160;
const CLOCK_STYLE: DotMatrixTextStyle = { cellSize: 9, cellGap: 2, letterGap: 8, glowStrength: 0.2 };
const DAY_STYLE: DotMatrixTextStyle = { cellSize: 4, cellGap: 2, letterGap: 4, glowStrength: 0.16 };
const MESSAGE_STYLE: DotMatrixTextStyle = { cellSize: 6, cellGap: 2, letterGap: 6, glowStrength: 0.18 };
const HEADER_STYLE: DotMatrixTextStyle = { cellSize: 2, cellGap: 1, letterGap: 2, glowStrength: 0.14 };
const BODY_STYLE: DotMatrixTextStyle = { cellSize: 5, cellGap: 2, letterGap: 4, glowStrength: 0.18 };
const VOLUME_STYLE: DotMatrixTextStyle = { cellSize: 7, cellGap: 2, letterGap: 6, glowStrength: 0.2 };

export type PowerDisplayPhase = 'blackout' | 'volume' | 'final-blackout' | 'ready';

export function getPowerDisplayPhase(elapsedSeconds: number): PowerDisplayPhase {
  if (elapsedSeconds < POWER_BLACKOUT_SECONDS) return 'blackout';
  if (elapsedSeconds < POWER_BLACKOUT_SECONDS + POWER_VOLUME_SECONDS) return 'volume';
  if (elapsedSeconds < POWER_STARTUP_SECONDS) return 'final-blackout';
  return 'ready';
}

export function composeLocalYRotation(
  base: THREE.Quaternion,
  angle: number,
  target = new THREE.Quaternion(),
  localRotation = new THREE.Quaternion(),
): THREE.Quaternion {
  localRotation.setFromAxisAngle(LID_LOCAL_AXIS, angle);
  return target.copy(base).multiply(localRotation);
}

export interface PlayerPrefabBindings {
  root: THREE.Object3D;
  discSocket: THREE.Object3D;
  powerButton: THREE.Object3D;
  volumeUpButton: THREE.Object3D;
  volumeDownButton: THREE.Object3D;
  sourceSelectButton: THREE.Object3D;
  playPauseButton: THREE.Object3D;
  nextButton: THREE.Object3D;
  previousButton: THREE.Object3D;
  stopButton: THREE.Object3D;
  lidInteraction: THREE.Object3D;
  lidRotationParent: THREE.Object3D;
}

interface ButtonAnimation {
  baseY: number;
  pressedUntil: number;
}

function requireObject(root: THREE.Object3D, name: string, assetPath: string): THREE.Object3D {
  const object = root.getObjectByName(name);
  if (object) return object;
  const available = root.children.map((child) => child.name).filter(Boolean).join(', ');
  throw new Error(`Missing required player object "${name}" in ${assetPath}. Top-level objects: ${available}`);
}

function replaceMaterial(root: THREE.Object3D, sourceName: string, replacement: THREE.Material): number {
  let replacements = 0;
  root.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    if (Array.isArray(object.material)) {
      object.material = object.material.map((material) => {
        if (material.name !== sourceName) return material;
        replacements += 1;
        return replacement;
      });
    } else if (object.material.name === sourceName) {
      object.material = replacement;
      replacements += 1;
    }
  });
  if (replacements === 0) throw new Error(`Player material binding "${sourceName}" did not match any mesh.`);
  return replacements;
}

function applyPlayerMaps(material: THREE.MeshStandardMaterial, maps: TextureMaps): void {
  material.map = maps.baseColor ?? null;
  material.normalMap = maps.normal ?? null;
  material.aoMap = maps.orm ?? null;
  material.roughnessMap = maps.orm ?? null;
  material.metalnessMap = maps.orm ?? null;
  material.needsUpdate = true;
}

export class PlayerPrefabRuntime {
  readonly bindings: PlayerPrefabBindings;
  private readonly animatedButtons = new Map<THREE.Object3D, ButtonAnimation>();
  private readonly ownedMaterials: THREE.Material[] = [];
  private readonly ownedTextures: THREE.Texture[] = [];
  private readonly releaseEnvironmentBindings: Array<() => void> = [];
  private readonly textureStreams: TextureStreamHandle[];
  private readonly unsubscribe: () => void;
  private readonly screenCanvas: HTMLCanvasElement;
  private readonly screenTexture: THREE.CanvasTexture;
  private readonly statusMaterial: THREE.MeshStandardMaterial;
  private readonly controlBarMaterial: THREE.MeshStandardMaterial;
  private startupElapsed = 0;
  private starting = false;
  private powerDisplayPhase: PowerDisplayPhase = 'ready';
  private volumeOverlayElapsed = 0;
  private cdReadingElapsed: number | null = null;
  private cdReadingDuration = 0;
  private cdBlinkVisible = true;
  private disc: THREE.Object3D | null = null;
  private discSpinAngle = 0;
  private discSpinVelocity = 0;
  private lidElapsed = 0;
  private lidStartAngle = 0;
  private lidTargetAngle = 0;
  private lidCurrentAngle = 0;
  private lidAnimating = false;
  private readonly lidBaseQuaternion: THREE.Quaternion;
  private readonly lidDeltaQuaternion = new THREE.Quaternion();
  private displayedMinute = -1;

  private constructor(
    bindings: PlayerPrefabBindings,
    private readonly store: Store,
    materials: {
      body: THREE.MeshStandardMaterial;
      screen: THREE.MeshStandardMaterial;
      screenGlass: THREE.MeshPhysicalMaterial;
      lidGlass: THREE.MeshPhysicalMaterial;
      status: THREE.MeshStandardMaterial;
      controlBar: THREE.MeshStandardMaterial;
    },
    textures: THREE.Texture[],
    textureStreams: TextureStreamHandle[],
    screenCanvas: HTMLCanvasElement,
  ) {
    this.bindings = bindings;
    this.statusMaterial = materials.status;
    this.controlBarMaterial = materials.controlBar;
    this.ownedMaterials.push(...Object.values(materials));
    this.ownedTextures.push(...textures);
    this.textureStreams = textureStreams;
    this.screenCanvas = screenCanvas;
    this.screenTexture = materials.screen.emissiveMap as THREE.CanvasTexture;
    this.lidBaseQuaternion = bindings.lidRotationParent.quaternion.clone();
    [bindings.powerButton, bindings.volumeUpButton, bindings.volumeDownButton].forEach((button) => {
      this.animatedButtons.set(button, { baseY: button.position.y, pressedUntil: 0 });
    });
    this.unsubscribe = store.subscribe((next, previous) => this.onState(next, previous));
    this.applyPowerPresentation(store.getState());
    this.drawDisplay(store.getState());
  }

  static async create(
    root: THREE.Object3D,
    store: Store,
    assetPath: string,
    studioEnvironment: StudioEnvironmentRuntime,
    textureStreaming: TextureStreamingRuntime,
  ): Promise<PlayerPrefabRuntime> {
    const body = new THREE.MeshStandardMaterial({
      name: 'M_Player1_Runtime',
      roughness: 1,
      metalness: 1,
    });
    const screenCanvas = document.createElement('canvas');
    screenCanvas.width = SCREEN_WIDTH;
    screenCanvas.height = SCREEN_HEIGHT;
    const screenTexture = new THREE.CanvasTexture(screenCanvas);
    screenTexture.colorSpace = THREE.SRGBColorSpace;
    screenTexture.magFilter = THREE.NearestFilter;
    screenTexture.minFilter = THREE.NearestFilter;
    screenTexture.flipY = false;
    const screen = new THREE.MeshStandardMaterial({
      name: 'M_Screen_Runtime',
      color: 0x050505,
      emissive: 0xffffff,
      emissiveMap: screenTexture,
      emissiveIntensity: 1.8,
      roughness: 0.7,
      metalness: 0,
    });
    const screenGlass = new THREE.MeshPhysicalMaterial({
      name: 'M_ScreenGlass1_Runtime',
      color: 0x101719,
      transparent: true,
      opacity: 0.5,
      roughness: 0.18,
      metalness: 0.1,
      depthWrite: false,
    });
    const lidGlass = new THREE.MeshPhysicalMaterial({
      name: 'M_GlassLid1_Runtime',
      color: 0x111719,
      transparent: true,
      opacity: 0.48,
      transmission: 0.22,
      roughness: 0.22,
      metalness: 0.05,
      depthWrite: false,
    });
    const status = new THREE.MeshStandardMaterial({ name: 'M_StatusLight1_Runtime', roughness: 0.35 });
    const controlBarMaterial = new THREE.MeshStandardMaterial({
      name: 'M_ControlBar_Runtime',
      color: 0x010101,
      emissive: 0x000000,
      emissiveIntensity: 0,
      roughness: 0.7,
    });
    const [bodyTextureStream, controlBarTextureStream] = await Promise.all([
      textureStreaming.stream(TEXTURES.player, { label: 'Player PBR', priority: 20 }, (maps, tier) => {
        applyPlayerMaps(body, maps);
        body.userData.textureTier = tier;
      }),
      textureStreaming.stream(TEXTURES.controlBar, { label: 'Player control bar', priority: 20 }, (maps, tier) => {
        controlBarMaterial.emissiveMap = maps.emissive ?? null;
        controlBarMaterial.userData.textureTier = tier;
        controlBarMaterial.needsUpdate = true;
      }),
    ]);

    replaceMaterial(root, 'M_Player1', body);
    replaceMaterial(root, 'M_Screen', screen);
    replaceMaterial(root, 'M_ScreenGlass1', screenGlass);
    replaceMaterial(root, 'M_GlassLid1', lidGlass);
    replaceMaterial(root, 'M_StatusLight1', status);
    replaceMaterial(root, 'M_ControlBar', controlBarMaterial);
    root.traverse((object) => {
      if (object.name.startsWith('BtnScreen_')) object.visible = false;
    });

    const runtime = new PlayerPrefabRuntime({
      root,
      discSocket: requireObject(root, 'SOKET_CD', assetPath),
      powerButton: requireObject(root, 'SM_Button_Power', assetPath),
      volumeUpButton: requireObject(root, 'SM_Button_VOLUP', assetPath),
      volumeDownButton: requireObject(root, 'SM_Button_VOLDOWN', assetPath),
      sourceSelectButton: requireObject(root, 'BtnScreen_SELECT', assetPath),
      playPauseButton: requireObject(root, 'BtnScreen_PlayPause', assetPath),
      nextButton: requireObject(root, 'BtnScreen_Next', assetPath),
      previousButton: requireObject(root, 'BtnScreen_Prev', assetPath),
      stopButton: requireObject(root, 'BtnScreen_Stop', assetPath),
      lidInteraction: requireObject(root, 'SM_CDLid', assetPath),
      lidRotationParent: requireObject(root, 'CDLidRotParent1', assetPath),
    }, store, { body, screen, screenGlass, lidGlass, status, controlBar: controlBarMaterial }, [
      screenTexture,
    ], [bodyTextureStream, controlBarTextureStream], screenCanvas);
    runtime.releaseEnvironmentBindings.push(
      studioEnvironment.bindMaterial(body, 1.25),
      studioEnvironment.bindMaterial(screenGlass, 0.75),
      studioEnvironment.bindMaterial(lidGlass, 0.85),
    );
    return runtime;
  }

  pulseButton(button: THREE.Object3D): void {
    const animation = this.animatedButtons.get(button);
    if (animation) animation.pressedUntil = performance.now() + 130;
  }

  setDisc(disc: THREE.Object3D | null): void {
    this.disc = disc;
  }

  refreshPresentation(): void {
    this.applyPowerPresentation(this.store.getState());
    this.drawDisplay(this.store.getState());
  }

  update(deltaSeconds: number): void {
    if (this.starting) {
      this.startupElapsed += deltaSeconds;
      const phase = getPowerDisplayPhase(this.startupElapsed);
      if (phase !== this.powerDisplayPhase) {
        this.powerDisplayPhase = phase;
        this.drawDisplay(this.store.getState());
      }
      if (phase === 'ready') this.store.dispatch({ type: 'POWER_READY' });
    }
    if (this.volumeOverlayElapsed > 0) {
      this.volumeOverlayElapsed = Math.max(0, this.volumeOverlayElapsed - deltaSeconds);
      if (this.volumeOverlayElapsed === 0) this.drawDisplay(this.store.getState());
    }
    this.updateCdReading(deltaSeconds);
    const discSpinTarget = this.cdReadingElapsed !== null
      ? 11
      : this.store.getState().playback === 'playing' ? 8 : 0;
    this.discSpinVelocity = THREE.MathUtils.damp(this.discSpinVelocity, discSpinTarget, 3.5, deltaSeconds);
    this.discSpinAngle = (this.discSpinAngle + this.discSpinVelocity * deltaSeconds) % (Math.PI * 2);
    if (this.lidAnimating) this.updateLid(deltaSeconds);
    const now = performance.now();
    this.animatedButtons.forEach((animation, button) => {
      const target = now < animation.pressedUntil ? animation.baseY - BUTTON_PRESS_TRAVEL : animation.baseY;
      button.position.y = THREE.MathUtils.damp(button.position.y, target, 26, deltaSeconds);
    });
    const minute = new Date().getMinutes();
    if (this.store.getState().power === 'off' && minute !== this.displayedMinute) {
      this.drawDisplay(this.store.getState());
    }
    if (this.store.getState().insertedDiscId !== null && this.disc) {
      // Physics restores the snapped root quaternion every frame, so reapply the full visual phase.
      this.disc.rotateY(this.discSpinAngle);
    }
  }

  dispose(): void {
    this.unsubscribe();
    this.textureStreams.forEach((stream) => stream.dispose());
    this.releaseEnvironmentBindings.forEach((release) => release());
    this.ownedMaterials.forEach((material) => material.dispose());
    this.ownedTextures.forEach((texture) => texture.dispose());
  }

  private onState(next: AppState, previous: AppState): void {
    if (next.power !== previous.power) {
      this.starting = next.power === 'starting';
      this.startupElapsed = 0;
      this.powerDisplayPhase = next.power === 'starting' ? 'blackout' : 'ready';
      if (next.power === 'off') this.cancelCdReading();
      if (next.power === 'on' && next.selectedSource === 'cd') this.startCdReading(next);
      this.applyPowerPresentation(next);
    }
    if (next.volume !== previous.volume && next.power === 'on') this.volumeOverlayElapsed = 1;
    if (next.selectedSource !== previous.selectedSource) {
      this.cancelCdReading();
      if (next.selectedSource === 'cd') this.startCdReading(next);
    }
    if (next.transport !== previous.transport) {
      this.startLidTransition(next);
      if (next.transport !== 'closed') this.cancelCdReading();
      if (next.transport === 'closed' && next.selectedSource === 'cd') this.startCdReading(next);
    }
    this.drawDisplay(next);
  }

  private startCdReading(state: AppState): void {
    if (state.power !== 'on' || state.selectedSource !== 'cd' || state.transport !== 'closed') return;
    this.cdReadingElapsed = 0;
    this.cdReadingDuration = state.insertedDiscId !== null && state.tracks.length > 0
      ? CD_READING_WITH_DISC_SECONDS
      : CD_READING_EMPTY_SECONDS;
    this.cdBlinkVisible = true;
    this.store.dispatch({ type: 'CD_READING_STARTED' });
  }

  private cancelCdReading(): void {
    const wasReading = this.cdReadingElapsed !== null;
    this.cdReadingElapsed = null;
    this.cdBlinkVisible = true;
    if (wasReading) this.store.dispatch({ type: 'CD_READING_STOPPED' });
  }

  private updateCdReading(deltaSeconds: number): void {
    if (this.cdReadingElapsed === null) return;
    const state = this.store.getState();
    this.cdReadingElapsed += deltaSeconds;
    const blinkVisible = Math.floor(this.cdReadingElapsed / CD_BLINK_SECONDS) % 2 === 0;
    if (blinkVisible !== this.cdBlinkVisible) {
      this.cdBlinkVisible = blinkVisible;
      this.drawDisplay(state);
    }
    if (this.cdReadingElapsed < this.cdReadingDuration) return;
    this.cdReadingElapsed = null;
    this.cdBlinkVisible = true;
    if (state.insertedDiscId !== null && state.tracks.length > 0) {
      this.store.dispatch({ type: 'CD_READING_FINISHED' });
    } else {
      this.store.dispatch({ type: 'CD_READING_STOPPED' });
      this.drawDisplay(state);
    }
  }

  private startLidTransition(state: AppState): void {
    if (state.transport !== 'opening' && state.transport !== 'closing') return;
    this.lidStartAngle = this.lidCurrentAngle;
    this.lidTargetAngle = state.transport === 'opening' ? LID_OPEN_ROTATION : 0;
    this.lidElapsed = 0;
    this.lidAnimating = true;
  }

  private updateLid(deltaSeconds: number): void {
    this.lidElapsed += deltaSeconds;
    const progress = Math.min(1, this.lidElapsed / LID_TRANSITION_SECONDS);
    const eased = progress * progress * progress * (progress * (progress * 6 - 15) + 10);
    this.lidCurrentAngle = THREE.MathUtils.lerp(
      this.lidStartAngle,
      this.lidTargetAngle,
      eased,
    );
    composeLocalYRotation(
      this.lidBaseQuaternion,
      this.lidCurrentAngle,
      this.bindings.lidRotationParent.quaternion,
      this.lidDeltaQuaternion,
    );
    if (progress < 1) return;
    this.lidAnimating = false;
    this.store.dispatch({
      type: 'TRAY_TRANSITION_FINISHED',
      position: this.lidTargetAngle === 0 ? 'closed' : 'open',
    });
  }

  private applyPowerPresentation(state: AppState): void {
    const statusColor = state.power === 'off' ? 0xd22b22 : 0x249cff;
    this.statusMaterial.color.setHex(statusColor);
    this.statusMaterial.emissive.setHex(statusColor);
    this.statusMaterial.emissiveIntensity = 3;
    const controlBarOn = state.power === 'on';
    this.controlBarMaterial.emissive.setHex(controlBarOn ? 0xffffff : 0x000000);
    this.controlBarMaterial.emissiveIntensity = controlBarOn ? 1.6 : 0;
  }

  private drawDisplay(state: AppState): void {
    const context = this.screenCanvas.getContext('2d');
    if (!context) return;
    context.fillStyle = '#020303';
    context.fillRect(0, 0, SCREEN_WIDTH, SCREEN_HEIGHT);
    if (state.power === 'off') {
      const now = new Date();
      const day = new Intl.DateTimeFormat('en-GB', { weekday: 'short' }).format(now).toUpperCase();
      const time = new Intl.DateTimeFormat('en-GB', {
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
      }).format(now);
      const dayWidth = measureDotMatrixText(day, DAY_STYLE);
      const timeWidth = measureDotMatrixText(time, CLOCK_STYLE);
      const groupGap = 30;
      const groupX = (SCREEN_WIDTH - dayWidth - groupGap - timeWidth) / 2;
      drawDotMatrixText(context, day, groupX, 72, DAY_STYLE);
      drawDotMatrixText(context, time, groupX + dayWidth + groupGap, 41, CLOCK_STYLE);
      this.displayedMinute = now.getMinutes();
    } else if (state.power === 'starting') {
      if (this.powerDisplayPhase === 'volume') this.drawVolume(context, state.volume);
    } else if (this.volumeOverlayElapsed > 0) {
      this.drawVolume(context, state.volume);
    } else {
      this.drawSource(context, state);
    }
    this.screenTexture.needsUpdate = true;
  }

  private drawVolume(context: CanvasRenderingContext2D, volume: number): void {
    const label = `VOLUME ${String(volume).padStart(2, '0')}`;
    const width = measureDotMatrixText(label, VOLUME_STYLE);
    const boxX = 10;
    const boxY = 24;
    const boxWidth = SCREEN_WIDTH - boxX * 2;
    const boxHeight = 112;
    context.fillStyle = '#cbd1ca';
    for (let x = boxX; x <= boxX + boxWidth; x += 6) {
      context.fillRect(x, boxY, 4, 4);
      context.fillRect(x, boxY + boxHeight - 4, 4, 4);
    }
    for (let y = boxY; y <= boxY + boxHeight; y += 6) {
      context.fillRect(boxX, y, 4, 4);
      context.fillRect(boxX + boxWidth - 4, y, 4, 4);
    }
    drawDotMatrixText(context, label, (SCREEN_WIDTH - width) / 2, 52, VOLUME_STYLE);
  }

  private drawSource(context: CanvasRenderingContext2D, state: AppState): void {
    const labels: Record<InputSource, string> = {
      spotify: 'SPOTIFY',
      usb: 'USB',
      fm: 'FM',
      dab: 'DAB/DAB+',
      cast: 'GOOGLE CAST',
      bluetooth: 'BLUETOOTH',
      cd: 'CD',
    };
    this.drawHeader(context, labels[state.selectedSource], state.volume);
    switch (state.selectedSource) {
      case 'spotify':
        return;
      case 'usb':
        this.drawCenteredMessage(context, 'NO DEVICE', 66, BODY_STYLE);
        return;
      case 'fm':
        this.drawCenteredMessage(context, '87.50MHZ', 66, BODY_STYLE);
        return;
      case 'dab':
        drawDotMatrixText(context, 'AUTO SCAN >', 18, 76, BODY_STYLE);
        return;
      case 'cast':
        this.drawCenteredMessage(context, 'OPERATE VIA APP', 66, BODY_STYLE);
        return;
      case 'bluetooth':
        this.drawCenteredMessage(context, 'READY', 66, BODY_STYLE);
        return;
      case 'cd':
        this.drawCdState(context, state);
    }
  }

  private drawHeader(context: CanvasRenderingContext2D, source: string, volume: number): void {
    drawDotMatrixText(context, source, 18, 16, HEADER_STYLE);
    drawDotMatrixText(context, 'TONE', 350, 16, HEADER_STYLE);
    drawDotMatrixText(context, `<${String(volume).padStart(2, '0')}`, 440, 16, HEADER_STYLE);
  }

  private drawCdState(context: CanvasRenderingContext2D, state: AppState): void {
    if (state.transport !== 'closed') {
      this.drawCenteredMessage(context, 'CD OPEN', 66, BODY_STYLE);
      return;
    }
    if (this.cdReadingElapsed !== null) {
      if (this.cdBlinkVisible) this.drawCenteredMessage(context, 'READING', 66, BODY_STYLE);
      return;
    }
    if (state.discReady && state.insertedDiscId !== null) {
      const currentTrack = state.tracks[state.currentTrackIndex];
      if (state.playback !== 'stopped') {
        const marker = state.playback === 'playing' ? '>' : ' ';
        drawDotMatrixText(
          context,
          `${marker} TRACK ${String(state.currentTrackIndex + 1).padStart(2, '0')}`,
          54,
          62,
          BODY_STYLE,
        );
        drawDotMatrixText(context, this.formatDuration(state.playbackSeconds), 54, 116, HEADER_STYLE);
        drawDotMatrixText(context, this.formatDuration(currentTrack?.durationSeconds ?? 0), 405, 116, HEADER_STYLE);
        return;
      }
      const totalDuration = state.tracks.reduce((sum, track) => sum + track.durationSeconds, 0);
      drawDotMatrixText(context, `TOTAL TRACK ${state.tracks.length}`, 42, 62, BODY_STYLE);
      drawDotMatrixText(context, this.formatDuration(totalDuration), 405, 116, HEADER_STYLE);
      return;
    }
    this.drawCenteredMessage(context, 'NO DISC', 66, BODY_STYLE);
  }

  private formatDuration(durationSeconds: number): string {
    const seconds = Math.max(0, Math.round(durationSeconds));
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  }

  private drawCenteredMessage(
    context: CanvasRenderingContext2D,
    text: string,
    y = (SCREEN_HEIGHT - (7 * MESSAGE_STYLE.cellSize + 6 * MESSAGE_STYLE.cellGap)) / 2,
    style: DotMatrixTextStyle = MESSAGE_STYLE,
  ): void {
    const width = measureDotMatrixText(text, style);
    drawDotMatrixText(context, text, (SCREEN_WIDTH - width) / 2, y, style);
  }
}
