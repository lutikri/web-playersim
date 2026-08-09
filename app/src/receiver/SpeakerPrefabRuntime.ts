import * as THREE from 'three';
import { replaceMaterialNamed } from '../scene/SceneMaterialRuntime';
import type { StudioEnvironmentRuntime } from '../scene/StudioEnvironmentRuntime';
import type {
  TextureMaps,
  TextureStreamHandle,
  TextureStreamingRuntime,
} from '../scene/TextureStreamingRuntime';

const SPEAKER_TEXTURES = {
  low: {
    baseColor: new URL('../../assets/runtime-textures/T_Spekaer1_BaseColor_1K.ktx2', import.meta.url).href,
    normal: new URL('../../assets/runtime-textures/T_Spekaer1_Normal_1K.ktx2', import.meta.url).href,
    orm: new URL('../../assets/runtime-textures/T_Spekaer1_ORM_1K.ktx2', import.meta.url).href,
  },
  medium: {
    baseColor: new URL('../../assets/runtime-textures/T_Spekaer1_BaseColor_4K.ktx2', import.meta.url).href,
    normal: new URL('../../assets/runtime-textures/T_Spekaer1_Normal_4K.ktx2', import.meta.url).href,
    orm: new URL('../../assets/runtime-textures/T_Spekaer1_ORM_4K.ktx2', import.meta.url).href,
  },
  high: {
    baseColor: new URL('../../assets/runtime-textures/T_Spekaer1_BaseColor_4K.png', import.meta.url).href,
    normal: new URL('../../assets/runtime-textures/T_Spekaer1_Normal_4K.png', import.meta.url).href,
    orm: new URL('../../assets/runtime-textures/T_Spekaer1_ORM_4K.png', import.meta.url).href,
  },
} as const;

const SPEAKER_MATERIAL = 'M_Speaker1';
const LOW_MEMBRANE_NAME = 'SM_Speaker1_MembraneLow';
const HIGH_MEMBRANE_NAME = 'SM_Speaker1_MembraneHigh';

export interface SpeakerBandLevels {
  low: number;
  high: number;
}

interface SpeakerResponse {
  lowMembrane: THREE.Object3D;
  highMembrane: THREE.Object3D;
  lowBaseX: number;
  highBaseX: number;
  lowLevel: number;
  highLevel: number;
  targetLowLevel: number;
  targetHighLevel: number;
}

function requireObject(root: THREE.Object3D, name: string): THREE.Object3D {
  const object = root.getObjectByName(name);
  if (!object) throw new Error(`Missing required speaker object "${name}".`);
  return object;
}

function createSpeakerResponse(root: THREE.Object3D): SpeakerResponse {
  const lowMembrane = requireObject(root, LOW_MEMBRANE_NAME);
  const highMembrane = requireObject(root, HIGH_MEMBRANE_NAME);
  return {
    lowMembrane,
    highMembrane,
    lowBaseX: lowMembrane.position.x,
    highBaseX: highMembrane.position.x,
    lowLevel: 0,
    highLevel: 0,
    targetLowLevel: 0,
    targetHighLevel: 0,
  };
}

function applySpeakerMaps(material: THREE.MeshStandardMaterial, maps: TextureMaps): void {
  material.map = maps.baseColor ?? null;
  material.normalMap = maps.normal ?? null;
  material.aoMap = maps.orm ?? null;
  material.roughnessMap = maps.orm ?? null;
  material.metalnessMap = maps.orm ?? null;
  material.needsUpdate = true;
}

export class SpeakerPrefabRuntime {
  private lowPhase = 0;
  private highPhase = 0;

  private constructor(
    private readonly material: THREE.MeshStandardMaterial,
    private readonly textureStream: TextureStreamHandle,
    private readonly releaseEnvironmentBinding: () => void,
    private readonly responses: readonly [SpeakerResponse, SpeakerResponse],
  ) {}

  static async create(
    roots: readonly [THREE.Object3D, THREE.Object3D],
    studioEnvironment: StudioEnvironmentRuntime,
    textureStreaming: TextureStreamingRuntime,
  ): Promise<SpeakerPrefabRuntime> {
    const material = new THREE.MeshStandardMaterial({
      name: SPEAKER_MATERIAL,
      color: 0xffffff,
      roughness: 1,
      metalness: 1,
    });
    const textureStream = await textureStreaming.stream(
      SPEAKER_TEXTURES,
      { label: 'Speaker PBR', priority: 10 },
      (maps, tier) => {
        applySpeakerMaps(material, maps);
        material.userData.textureTier = tier;
      },
    );
    const replaced = replaceMaterialNamed([...roots], SPEAKER_MATERIAL, material);
    if (replaced.size === 0) {
      textureStream.dispose();
      material.dispose();
      throw new Error(`Speaker material binding "${SPEAKER_MATERIAL}" did not match any mesh.`);
    }
    replaced.forEach((source) => source.dispose());
    const responses: [SpeakerResponse, SpeakerResponse] = [
      createSpeakerResponse(roots[0]),
      createSpeakerResponse(roots[1]),
    ];
    return new SpeakerPrefabRuntime(
      material,
      textureStream,
      studioEnvironment.bindMaterial(material, 1.15),
      responses,
    );
  }

  setLevels(levels: readonly [SpeakerBandLevels, SpeakerBandLevels]): void {
    this.responses.forEach((response, index) => {
      response.targetLowLevel = THREE.MathUtils.clamp(levels[index].low, 0, 1);
      response.targetHighLevel = THREE.MathUtils.clamp(levels[index].high, 0, 1);
    });
  }

  update(deltaSeconds: number): void {
    this.lowPhase = (this.lowPhase + deltaSeconds * Math.PI * 2 * 26) % (Math.PI * 2);
    this.highPhase = (this.highPhase + deltaSeconds * Math.PI * 2 * 43) % (Math.PI * 2);
    this.responses.forEach((response, index) => {
      response.lowLevel = THREE.MathUtils.damp(response.lowLevel, response.targetLowLevel, 18, deltaSeconds);
      response.highLevel = THREE.MathUtils.damp(response.highLevel, response.targetHighLevel, 28, deltaSeconds);
      const stereoPhase = index * 0.31;
      response.lowMembrane.position.x = response.lowBaseX
        + Math.sin(this.lowPhase + stereoPhase) * response.lowLevel * 0.0012;
      response.highMembrane.position.x = response.highBaseX
        + Math.sin(this.highPhase + stereoPhase) * response.highLevel * 0.00028;
    });
  }

  dispose(): void {
    this.responses.forEach((response) => {
      response.lowMembrane.position.x = response.lowBaseX;
      response.highMembrane.position.x = response.highBaseX;
    });
    this.releaseEnvironmentBinding();
    this.textureStream.dispose();
    this.material.dispose();
  }
}
