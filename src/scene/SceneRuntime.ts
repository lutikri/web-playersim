import * as THREE from 'three';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { Store } from '../app/Store';
import { PlayerPrefabRuntime } from '../receiver/PlayerPrefabRuntime';
import type { StudioEnvironmentRuntime } from './StudioEnvironmentRuntime';
import { SceneMaterialRuntime } from './SceneMaterialRuntime';
import type { TextureStreamingRuntime } from './TextureStreamingRuntime';

const ASSETS = {
  level: new URL('../../assets/enviroment/Scene0.glb', import.meta.url).href,
  cd: new URL('../../assets/Prefabs/SM_CD1.glb', import.meta.url).href,
  player: new URL('../../assets/Prefabs/SM_Player1.glb', import.meta.url).href,
  speaker: new URL('../../assets/Prefabs/SM_Speaker1.glb', import.meta.url).href,
} as const;

const COLLIDER_PATTERN = /^(?:U[BC]X)_/;

export interface SceneBindings {
  disc: THREE.Object3D;
  player: THREE.Object3D;
  speaker: THREE.Object3D;
  discSocket: THREE.Object3D;
  powerButton: THREE.Object3D;
  volumeUpButton: THREE.Object3D;
  volumeDownButton: THREE.Object3D;
  lidInteraction: THREE.Object3D;
  colliders: THREE.Object3D[];
  editableObjects: THREE.Object3D[];
}

function requireObject(root: THREE.Object3D, name: string, assetPath: string): THREE.Object3D {
  const object = root.getObjectByName(name);
  if (object) return object;
  const available = root.children.map((child) => child.name).filter(Boolean).join(', ');
  throw new Error(`Missing required object "${name}" in ${assetPath}. Top-level objects: ${available}`);
}

function setFromMarker(object: THREE.Object3D, marker: THREE.Object3D): void {
  marker.updateWorldMatrix(true, false);
  marker.matrixWorld.decompose(object.position, object.quaternion, object.scale);
}

function configureMeshes(root: THREE.Object3D, colliders: THREE.Object3D[]): void {
  root.traverse((object) => {
    if (COLLIDER_PATTERN.test(object.name)) {
      object.visible = false;
      colliders.push(object);
      return;
    }
    if (!(object instanceof THREE.Mesh)) return;
    object.castShadow = true;
    object.receiveShadow = true;
  });
}

export class SceneRuntime {
  private readonly loader = new GLTFLoader();
  private readonly dracoLoader = new DRACOLoader();
  private playerRuntime: PlayerPrefabRuntime | null = null;
  private sceneMaterialRuntime: SceneMaterialRuntime | null = null;
  private bindingsValue: SceneBindings | null = null;

  constructor(
    private readonly scene: THREE.Scene,
    private readonly store: Store,
    private readonly studioEnvironment: StudioEnvironmentRuntime,
    private readonly textureStreaming: TextureStreamingRuntime,
  ) {
    this.dracoLoader.setDecoderPath('/');
    this.loader.setDRACOLoader(this.dracoLoader);
  }

  get bindings(): SceneBindings {
    if (!this.bindingsValue) throw new Error('Scene bindings requested before assets finished loading.');
    return this.bindingsValue;
  }

  async load(): Promise<SceneBindings> {
    const [levelGltf, cdGltf, playerGltf, speakerGltf] = await Promise.all([
      this.loader.loadAsync(ASSETS.level),
      this.loader.loadAsync(ASSETS.cd),
      this.loader.loadAsync(ASSETS.player),
      this.loader.loadAsync(ASSETS.speaker),
    ]);
    const level = levelGltf.scene;
    const cd = cdGltf.scene;
    const player = playerGltf.scene;
    const speaker = speakerGltf.scene;
    level.name = 'Level';
    cd.name = 'CD';
    player.name = 'Player';
    speaker.name = 'Speaker';
    setFromMarker(cd, requireObject(level, 'PF_CD1', ASSETS.level));
    setFromMarker(player, requireObject(level, 'PF_Player1', ASSETS.level));
    setFromMarker(speaker, requireObject(level, 'PF_Speaker1', ASSETS.level));
    ['PF_CD1', 'PF_Player1', 'PF_Speaker1'].forEach((name) => {
      requireObject(level, name, ASSETS.level).removeFromParent();
    });

    const colliders: THREE.Object3D[] = [];
    [level, cd, player, speaker].forEach((root) => configureMeshes(root, colliders));
    this.sceneMaterialRuntime = await SceneMaterialRuntime.create(
      [level, cd, player, speaker],
      this.textureStreaming,
    );
    this.scene.add(level, cd, player, speaker);

    this.playerRuntime = await PlayerPrefabRuntime.create(
      player,
      this.store,
      ASSETS.player,
      this.studioEnvironment,
      this.textureStreaming,
    );
    const playerBindings = this.playerRuntime.bindings;

    this.bindingsValue = {
      disc: cd,
      player,
      speaker,
      discSocket: playerBindings.discSocket,
      powerButton: playerBindings.powerButton,
      volumeUpButton: playerBindings.volumeUpButton,
      volumeDownButton: playerBindings.volumeDownButton,
      lidInteraction: playerBindings.lidInteraction,
      colliders,
      editableObjects: [level, cd, player, speaker],
    };
    return this.bindingsValue;
  }

  pulseButton(button: THREE.Object3D): void {
    this.playerRuntime?.pulseButton(button);
  }

  refreshPresentation(): void {
    this.playerRuntime?.refreshPresentation();
  }

  update(deltaSeconds: number): void {
    this.playerRuntime?.update(deltaSeconds);
  }

  setCollidersVisible(visible: boolean): void {
    this.bindings.colliders.forEach((collider) => {
      collider.visible = visible;
      collider.traverse((child) => {
        if (!(child instanceof THREE.Mesh)) return;
        const material = new THREE.MeshBasicMaterial({ color: 0x25d0ff, wireframe: true });
        child.material = material;
      });
    });
  }

  dispose(): void {
    this.playerRuntime?.dispose();
    this.sceneMaterialRuntime?.dispose();
    this.dracoLoader.dispose();
  }
}
