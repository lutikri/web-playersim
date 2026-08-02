import * as THREE from 'three';
import type { AppState, Store } from '../app/Store';
import type { StudioEnvironmentRuntime } from '../scene/StudioEnvironmentRuntime';
import type { TextureMaps, TextureStreamingRuntime, TextureStreamHandle } from '../scene/TextureStreamingRuntime';

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

const POWER_STARTUP_SECONDS = 1;
const LID_TRANSITION_SECONDS = 0.7;
const LID_OPEN_ROTATION = Math.PI;
const LID_LOCAL_AXIS = new THREE.Vector3(0, 1, 0);
const BUTTON_PRESS_TRAVEL = 0.0006;
const SCREEN_WIDTH = 530;
const SCREEN_HEIGHT = 160;

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

  refreshPresentation(): void {
    this.applyPowerPresentation(this.store.getState());
    this.drawDisplay(this.store.getState());
  }

  update(deltaSeconds: number): void {
    if (this.starting) {
      this.startupElapsed += deltaSeconds;
      if (this.startupElapsed >= POWER_STARTUP_SECONDS) this.store.dispatch({ type: 'POWER_READY' });
    }
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
      this.applyPowerPresentation(next);
    }
    if (next.transport !== previous.transport) this.startLidTransition(next);
    this.drawDisplay(next);
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
    const eased = progress * progress * (3 - 2 * progress);
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
    const statusColor = state.power === 'on' ? 0x249cff : state.power === 'off' ? 0xd22b22 : 0x000000;
    this.statusMaterial.color.setHex(statusColor);
    this.statusMaterial.emissive.setHex(statusColor);
    this.statusMaterial.emissiveIntensity = state.power === 'starting' ? 0 : 3;
    const controlBarOn = state.power === 'on';
    this.controlBarMaterial.emissive.setHex(controlBarOn ? 0xffffff : 0x000000);
    this.controlBarMaterial.emissiveIntensity = controlBarOn ? 1.6 : 0;
  }

  private drawDisplay(state: AppState): void {
    const context = this.screenCanvas.getContext('2d');
    if (!context) return;
    context.fillStyle = '#020303';
    context.fillRect(0, 0, SCREEN_WIDTH, SCREEN_HEIGHT);
    let text: string;
    if (state.power === 'off') {
      text = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' }).format(new Date());
      this.displayedMinute = new Date().getMinutes();
    } else if (state.power === 'starting') {
      text = 'PLEASE WAIT';
    } else {
      text = state.discLocation === 'player' ? 'DISC READY' : 'NO CD';
    }
    context.fillStyle = '#f1f5ed';
    context.font = `700 ${text.length > 8 ? 54 : 76}px monospace`;
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillText(text, SCREEN_WIDTH / 2, SCREEN_HEIGHT / 2 + 3);
    this.screenTexture.needsUpdate = true;
  }
}
