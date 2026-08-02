import * as THREE from 'three';
import type { TextureMaps, TextureStreamingRuntime, TextureStreamHandle } from './TextureStreamingRuntime';

const ASTEROID_BLACK_TEXTURES = {
  low: {
    baseColor: new URL('../../assets/runtime-textures/T_AsteroidBlack_BaseColor_1K.ktx2', import.meta.url).href,
    normal: new URL('../../assets/runtime-textures/T_AsteroidBlack_Normal_1K.ktx2', import.meta.url).href,
    roughness: new URL('../../assets/runtime-textures/T_AsteroidBlack_Roughness_1K.ktx2', import.meta.url).href,
  },
  medium: {
    baseColor: new URL('../../assets/runtime-textures/T_AsteroidBlack_BaseColor_2K.ktx2', import.meta.url).href,
    normal: new URL('../../assets/runtime-textures/T_AsteroidBlack_Normal_2K.ktx2', import.meta.url).href,
    roughness: new URL('../../assets/runtime-textures/T_AsteroidBlack_Roughness_2K.ktx2', import.meta.url).href,
  },
} as const;

const ASTEROID_BLACK_MATERIAL = 'M_AsteroidBlack';
const ASTEROID_BLACK_TILING = 4;

function assignedMaterials(mesh: THREE.Mesh): THREE.Material[] {
  return Array.isArray(mesh.material) ? mesh.material : [mesh.material];
}

export function hasMaterialNamed(roots: THREE.Object3D[], materialName: string): boolean {
  return roots.some((root) => {
    let found = false;
    root.traverse((object) => {
      if (found || !(object instanceof THREE.Mesh)) return;
      found = assignedMaterials(object).some((material) => material.name === materialName);
    });
    return found;
  });
}

export function replaceMaterialNamed(
  roots: THREE.Object3D[],
  materialName: string,
  replacement: THREE.Material,
): Set<THREE.Material> {
  const replacedMaterials = new Set<THREE.Material>();
  roots.forEach((root) => {
    root.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return;
      if (Array.isArray(object.material)) {
        object.material = object.material.map((material) => {
          if (material.name !== materialName) return material;
          replacedMaterials.add(material);
          return replacement;
        });
      } else if (object.material.name === materialName) {
        replacedMaterials.add(object.material);
        object.material = replacement;
      }
    });
  });
  return replacedMaterials;
}

export function prepareTiledTexture(texture: THREE.Texture, colorSpace: THREE.ColorSpace): THREE.Texture {
  texture.flipY = false;
  texture.colorSpace = colorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(ASTEROID_BLACK_TILING, ASTEROID_BLACK_TILING);
  texture.anisotropy = 8;
  texture.needsUpdate = true;
  return texture;
}

function applyAsteroidMaps(material: THREE.MeshStandardMaterial, maps: TextureMaps): void {
  material.map = maps.baseColor ?? null;
  material.normalMap = maps.normal ?? null;
  material.roughnessMap = maps.roughness ?? null;
  material.needsUpdate = true;
}

export class SceneMaterialRuntime {
  private constructor(
    private readonly material: THREE.MeshStandardMaterial | null,
    private readonly textureStream: TextureStreamHandle | null,
  ) {}

  static async create(
    roots: THREE.Object3D[],
    textureStreaming: TextureStreamingRuntime,
  ): Promise<SceneMaterialRuntime> {
    if (!hasMaterialNamed(roots, ASTEROID_BLACK_MATERIAL)) {
      return new SceneMaterialRuntime(null, null);
    }

    const material = new THREE.MeshStandardMaterial({
      name: ASTEROID_BLACK_MATERIAL,
      roughness: 1,
      metalness: 0,
    });
    const textureStream = await textureStreaming.stream(
      ASTEROID_BLACK_TEXTURES,
      { label: 'Asteroid black', priority: 5, repeat: ASTEROID_BLACK_TILING },
      (maps, tier) => {
        applyAsteroidMaps(material, maps);
        material.userData.textureTier = tier;
      },
    );
    const replacedMaterials = replaceMaterialNamed(roots, ASTEROID_BLACK_MATERIAL, material);
    replacedMaterials.forEach((replaced) => replaced.dispose());
    return new SceneMaterialRuntime(material, textureStream);
  }

  dispose(): void {
    this.textureStream?.dispose();
    this.material?.dispose();
  }
}
