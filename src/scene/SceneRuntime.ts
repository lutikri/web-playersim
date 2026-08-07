import * as THREE from 'three';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { Store } from '../app/Store';
import { DiscPrefabRuntime } from '../receiver/DiscPrefabRuntime';
import { PlayerPrefabRuntime } from '../receiver/PlayerPrefabRuntime';
import { SpeakerPrefabRuntime, type SpeakerBandLevels } from '../receiver/SpeakerPrefabRuntime';
import type { StudioEnvironmentRuntime } from './StudioEnvironmentRuntime';
import { SceneMaterialRuntime } from './SceneMaterialRuntime';
import type { TextureStreamingRuntime } from './TextureStreamingRuntime';
import type { CameraPose } from './CameraRuntime';

const ASSETS = {
  level: new URL('../../assets/enviroment/Scene0.glb', import.meta.url).href,
  cd: new URL('../../assets/Prefabs/SM_CD1.glb', import.meta.url).href,
  player: new URL('../../assets/Prefabs/SM_Player1.glb', import.meta.url).href,
  speaker: new URL('../../assets/Prefabs/SM_Speaker1.glb', import.meta.url).href,
} as const;

const COLLIDER_PATTERN = /^(?:U[BC]X)_/;

export interface SceneBindings {
  player: THREE.Object3D;
  speakers: readonly [THREE.Object3D, THREE.Object3D];
  speakerLowEmitters: readonly [THREE.Object3D, THREE.Object3D];
  speakerHighEmitters: readonly [THREE.Object3D, THREE.Object3D];
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
  colliders: THREE.Object3D[];
  editableObjects: THREE.Object3D[];
}

export interface SpawnedDiscBinding {
  id: number;
  root: THREE.Object3D;
  collider: THREE.Object3D;
}

interface AuthoredTransform {
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
  scale: THREE.Vector3;
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

function cloneMaterials(root: THREE.Object3D): void {
  root.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    object.material = Array.isArray(object.material)
      ? object.material.map((material) => material.clone())
      : object.material.clone();
  });
}

function ensureFallbackBoxCollider(root: THREE.Object3D, source: THREE.Object3D, colliders: THREE.Object3D[]): void {
  if (colliders.some((collider) => {
    let ancestor: THREE.Object3D | null = collider;
    while (ancestor) {
      if (ancestor === root) return true;
      ancestor = ancestor.parent;
    }
    return false;
  })) return;
  if (!(source instanceof THREE.Mesh)) throw new Error(`Collision fallback source "${source.name}" must be a Mesh.`);
  source.geometry.computeBoundingBox();
  const bounds = source.geometry.boundingBox;
  if (!bounds) throw new Error(`Collision fallback source "${source.name}" has no bounding box.`);
  const size = bounds.getSize(new THREE.Vector3());
  const center = bounds.getCenter(new THREE.Vector3()).multiply(source.scale).applyQuaternion(source.quaternion);
  const collider = new THREE.Mesh(new THREE.BoxGeometry(size.x, size.y, size.z));
  collider.name = 'UBX_Player_RuntimeFallback_01';
  collider.position.copy(source.position).add(center);
  collider.quaternion.copy(source.quaternion);
  collider.scale.copy(source.scale);
  collider.visible = false;
  source.parent?.add(collider);
  colliders.push(collider);
}

export class SceneRuntime {
  private readonly loader = new GLTFLoader();
  private readonly dracoLoader = new DRACOLoader();
  private playerRuntime: PlayerPrefabRuntime | null = null;
  private speakerRuntime: SpeakerPrefabRuntime | null = null;
  private readonly discRuntimes = new Map<number, DiscPrefabRuntime>();
  private readonly discRoots = new Map<number, THREE.Object3D>();
  private discTemplate: THREE.Object3D | null = null;
  private readonly discSpawnPosition = new THREE.Vector3();
  private readonly discSpawnQuaternion = new THREE.Quaternion();
  private readonly discSpawnScale = new THREE.Vector3(1, 1, 1);
  private readonly discPlacements = new Map<string, AuthoredTransform>();
  private sceneMaterialRuntime: SceneMaterialRuntime | null = null;
  private bindingsValue: SceneBindings | null = null;
  private readonly authoredTransforms = new Map<THREE.Object3D, AuthoredTransform>();
  private readonly cameraPosesValue: CameraPose[] = [];
  private readonly cameraHintsValue: THREE.Object3D[] = [];
  private readonly productCardAnchorsValue: THREE.Object3D[] = [];

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

  get cameraPoses(): readonly CameraPose[] {
    return this.cameraPosesValue;
  }

  get cameraHints(): readonly THREE.Object3D[] {
    return this.cameraHintsValue;
  }

  get productCardAnchors(): readonly THREE.Object3D[] {
    return this.productCardAnchorsValue;
  }

  async load(onProgress: (progress: number) => void = () => undefined): Promise<SceneBindings> {
    onProgress(0.04);
    let loadedAssets = 0;
    const loadAsset = async (url: string) => {
      const gltf = await this.loader.loadAsync(url);
      loadedAssets += 1;
      onProgress(0.08 + loadedAssets * 0.11);
      return gltf;
    };
    const [levelGltf, cdGltf, playerGltf, speakerGltf] = await Promise.all([
      loadAsset(ASSETS.level),
      loadAsset(ASSETS.cd),
      loadAsset(ASSETS.player),
      loadAsset(ASSETS.speaker),
    ]);
    const level = levelGltf.scene;
    this.discTemplate = cdGltf.scene.clone(true);
    cloneMaterials(this.discTemplate);
    const player = playerGltf.scene;
    const speakerLeft = speakerGltf.scene;
    const speakerRight = speakerGltf.scene.clone(true);
    level.name = 'Level';
    player.name = 'Player';
    speakerLeft.name = 'Speaker Left';
    speakerRight.name = 'Speaker Right';
    level.traverse((object) => {
      if (object instanceof THREE.PerspectiveCamera && object.name.startsWith('CAM_')) {
        this.cameraPosesValue.push({ name: object.name, camera: object });
      }
      if (object.name.startsWith('CAMHINT_')
        || (!(object instanceof THREE.PerspectiveCamera) && object.name.startsWith('CAM_'))) {
        this.cameraHintsValue.push(object);
      }
      if (object.name.startsWith('UI_ProductCard_')
        || object.name.startsWith('UI_ProductTarget_')
        || object.name.startsWith('UI_ProductCardTarget_')) {
        this.productCardAnchorsValue.push(object);
      }
    });
    const discMarker = requireObject(level, 'PF_CD1', ASSETS.level);
    discMarker.updateWorldMatrix(true, false);
    discMarker.matrixWorld.decompose(this.discSpawnPosition, this.discSpawnQuaternion, this.discSpawnScale);
    ['PF_ExampleDisk1', 'PF_ExampleDisk2'].forEach((name) => {
      const marker = requireObject(level, name, ASSETS.level);
      marker.updateWorldMatrix(true, false);
      const transform: AuthoredTransform = {
        position: new THREE.Vector3(),
        quaternion: new THREE.Quaternion(),
        scale: new THREE.Vector3(),
      };
      marker.matrixWorld.decompose(transform.position, transform.quaternion, transform.scale);
      this.discPlacements.set(name, transform);
    });
    setFromMarker(player, requireObject(level, 'PF_Player1', ASSETS.level));
    setFromMarker(speakerLeft, requireObject(level, 'PF_Speaker1_Speaker1', ASSETS.level));
    setFromMarker(speakerRight, requireObject(level, 'PF_Speaker1_Speaker2', ASSETS.level));
    [player, speakerLeft, speakerRight].forEach((object) => { object.userData.markerDriven = true; });
    [
      'PF_CD1',
      'PF_ExampleDisk1',
      'PF_ExampleDisk2',
      'PF_Player1',
      'PF_Speaker1_Speaker1',
      'PF_Speaker1_Speaker2',
    ].forEach((name) => {
      requireObject(level, name, ASSETS.level).removeFromParent();
    });

    const colliders: THREE.Object3D[] = [];
    [level, player, speakerLeft, speakerRight].forEach((root) => configureMeshes(root, colliders));
    ensureFallbackBoxCollider(player, requireObject(player, 'SM_Player1_Base1', ASSETS.player), colliders);
    this.sceneMaterialRuntime = await SceneMaterialRuntime.create(
      [level, player, speakerLeft, speakerRight],
      this.textureStreaming,
    );
    onProgress(0.68);
    this.speakerRuntime = await SpeakerPrefabRuntime.create(
      [speakerLeft, speakerRight],
      this.studioEnvironment,
      this.textureStreaming,
    );
    onProgress(0.78);
    onProgress(0.86);
    this.scene.add(level, player, speakerLeft, speakerRight);

    this.playerRuntime = await PlayerPrefabRuntime.create(
      player,
      this.store,
      ASSETS.player,
      this.studioEnvironment,
      this.textureStreaming,
    );
    onProgress(0.96);
    const playerBindings = this.playerRuntime.bindings;

    this.bindingsValue = {
      player,
      speakers: [speakerLeft, speakerRight],
      speakerLowEmitters: [
        requireObject(speakerLeft, 'SP_SpeakerLow1', ASSETS.speaker),
        requireObject(speakerRight, 'SP_SpeakerLow1', ASSETS.speaker),
      ],
      speakerHighEmitters: [
        requireObject(speakerLeft, 'SP_SpeakerHigh1', ASSETS.speaker),
        requireObject(speakerRight, 'SP_SpeakerHigh1', ASSETS.speaker),
      ],
      discSocket: playerBindings.discSocket,
      powerButton: playerBindings.powerButton,
      volumeUpButton: playerBindings.volumeUpButton,
      volumeDownButton: playerBindings.volumeDownButton,
      sourceSelectButton: playerBindings.sourceSelectButton,
      playPauseButton: playerBindings.playPauseButton,
      nextButton: playerBindings.nextButton,
      previousButton: playerBindings.previousButton,
      stopButton: playerBindings.stopButton,
      lidInteraction: playerBindings.lidInteraction,
      colliders,
      editableObjects: [level, player, speakerLeft, speakerRight, playerBindings.discLight],
    };
    this.bindingsValue.editableObjects.forEach((object) => {
      if (object instanceof THREE.Light) return;
      this.authoredTransforms.set(object, {
        position: object.position.clone(),
        quaternion: object.quaternion.clone(),
        scale: object.scale.clone(),
      });
    });
    onProgress(1);
    return this.bindingsValue;
  }

  resetEditableObjectTransforms(): THREE.Object3D[] {
    const reset: THREE.Object3D[] = [];
    this.authoredTransforms.forEach((transform, object) => {
      object.position.copy(transform.position);
      object.quaternion.copy(transform.quaternion);
      object.scale.copy(transform.scale);
      object.updateMatrixWorld(true);
      reset.push(object);
    });
    return reset;
  }

  pulseButton(button: THREE.Object3D): void {
    this.playerRuntime?.pulseButton(button);
  }

  refreshPresentation(): void {
    this.playerRuntime?.refreshPresentation();
  }

  async spawnDisc(id: number, cover: Blob | null, placementName?: string): Promise<SpawnedDiscBinding> {
    if (!this.discTemplate) throw new Error('Disc prefab requested before scene loading finished.');
    const root = this.discTemplate.clone(true);
    cloneMaterials(root);
    root.name = `Loaded CD ${id}`;
    const placement = placementName ? this.discPlacements.get(placementName) : undefined;
    root.position.copy(placement?.position ?? this.discSpawnPosition);
    root.quaternion.copy(placement?.quaternion ?? this.discSpawnQuaternion);
    root.scale.copy(placement?.scale ?? this.discSpawnScale);
    if (!placement) root.position.y += 0.32;
    root.userData.markerDriven = true;
    const dynamicColliders: THREE.Object3D[] = [];
    configureMeshes(root, dynamicColliders);
    const collider = requireObject(root, 'UCX_SM_Disk1_01', ASSETS.cd);
    const runtime = await DiscPrefabRuntime.create(root, this.studioEnvironment, this.textureStreaming);
    await runtime.setCoverBlob(cover);
    this.discRoots.set(id, root);
    this.discRuntimes.set(id, runtime);
    this.scene.add(root);
    return { id, root, collider };
  }

  update(deltaSeconds: number): void {
    const insertedDisc = this.store.getState().insertedDiscId;
    this.playerRuntime?.setDisc(insertedDisc === null ? null : this.discRoots.get(insertedDisc) ?? null);
    this.playerRuntime?.update(deltaSeconds);
    this.speakerRuntime?.update(deltaSeconds);
  }

  setSpeakerLevels(levels: readonly [SpeakerBandLevels, SpeakerBandLevels]): void {
    this.speakerRuntime?.setLevels(levels);
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
    this.discRuntimes.forEach((runtime) => runtime.dispose());
    this.discRoots.forEach((root) => root.removeFromParent());
    this.discRuntimes.clear();
    this.discRoots.clear();
    this.speakerRuntime?.dispose();
    this.sceneMaterialRuntime?.dispose();
    this.dracoLoader.dispose();
  }
}
