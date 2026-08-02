import * as THREE from 'three';
import type { StudioEnvironmentRuntime } from '../scene/StudioEnvironmentRuntime';
import type { TextureMaps, TextureStreamingRuntime, TextureStreamHandle } from '../scene/TextureStreamingRuntime';

const GRAPHIC_TEXTURES = {
  low: {
    baseColor: new URL('../../assets/runtime-textures/T_CD1_TestSample_1K.ktx2', import.meta.url).href,
  },
} as const;

function replaceMaterial(
  root: THREE.Object3D,
  sourceName: string,
  replacement: THREE.Material,
): Set<THREE.Material> {
  const replaced = new Set<THREE.Material>();
  root.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    const replace = (material: THREE.Material): THREE.Material => {
      if (material.name !== sourceName) return material;
      replaced.add(material);
      return replacement;
    };
    object.material = Array.isArray(object.material)
      ? object.material.map(replace)
      : replace(object.material);
  });
  if (replaced.size === 0) throw new Error(`Disc material binding "${sourceName}" did not match any mesh.`);
  return replaced;
}

function applyGraphicMap(material: THREE.MeshStandardMaterial, maps: TextureMaps): void {
  material.map = maps.baseColor ?? null;
  material.needsUpdate = true;
}

export function applyDiscRadialTangents(geometry: THREE.BufferGeometry): void {
  geometry.computeVertexNormals();
  const positions = geometry.getAttribute('position');
  if (!positions) throw new Error('Disc anisotropy geometry has no position attribute.');
  const tangents = new Float32Array(positions.count * 4);
  for (let index = 0; index < positions.count; index += 1) {
    const x = positions.getX(index);
    const z = positions.getZ(index);
    const length = Math.hypot(x, z);
    const offset = index * 4;
    tangents[offset] = length > 1e-6 ? (z === 0 ? 0 : -z / length) : 1;
    tangents[offset + 1] = 0;
    tangents[offset + 2] = length > 1e-6 ? (x === 0 ? 0 : x / length) : 0;
    tangents[offset + 3] = 1;
  }
  geometry.setAttribute('tangent', new THREE.BufferAttribute(tangents, 4));
}

export class DiscPrefabRuntime {
  private constructor(
    private readonly materials: THREE.Material[],
    private readonly textureStream: TextureStreamHandle,
    private readonly releaseEnvironmentBindings: Array<() => void>,
  ) {}

  static async create(
    root: THREE.Object3D,
    studioEnvironment: StudioEnvironmentRuntime,
    textureStreaming: TextureStreamingRuntime,
  ): Promise<DiscPrefabRuntime> {
    const graphic = new THREE.MeshStandardMaterial({
      name: 'M_DiskGraphic1',
      color: 0xffffff,
      roughness: 0.42,
      metalness: 0.08,
    });
    const transparent = new THREE.MeshPhysicalMaterial({
      name: 'M_DiskTransparent',
      color: 0xe8f1f3,
      transparent: true,
      opacity: 0.42,
      transmission: 0.62,
      roughness: 0.08,
      metalness: 0,
      ior: 1.49,
      thickness: 0.001,
      clearcoat: 0.3,
      clearcoatRoughness: 0.08,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const metallic = new THREE.MeshStandardMaterial({
      name: 'M_DiskMetallic',
      color: 0xaeb4bb,
      roughness: 0.2,
      metalness: 0.92,
    });
    const anisotrophic = new THREE.MeshPhysicalMaterial({
      name: 'M_DiskAnisotrophic',
      color: 0xc7ccd2,
      roughness: 0.14,
      metalness: 0.72,
      anisotropy: 1,
      anisotropyRotation: 0,
      iridescence: 0.9,
      iridescenceIOR: 1.3,
      iridescenceThicknessRange: [120, 520],
      clearcoat: 0.28,
      clearcoatRoughness: 0.1,
    });

    const textureStream = await textureStreaming.stream(
      GRAPHIC_TEXTURES,
      { label: 'CD graphic', priority: 15 },
      (maps, tier) => {
        applyGraphicMap(graphic, maps);
        graphic.userData.textureTier = tier;
      },
    );
    const replaced = new Set<THREE.Material>();
    root.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return;
      const assigned = Array.isArray(object.material) ? object.material : [object.material];
      if (assigned.some((material) => material.name === 'M_DiskAnisotrophic')) {
        applyDiscRadialTangents(object.geometry);
      }
    });
    const replacements: Array<[string, THREE.Material]> = [
      ['M_DiskGraphic1', graphic],
      ['M_DiskTransparent', transparent],
      ['M_DiskMetallic', metallic],
      ['M_DiskAnisotrophic', anisotrophic],
    ];
    replacements.forEach(([name, material]) => {
      replaceMaterial(root, name, material).forEach((item) => replaced.add(item));
    });
    replaced.forEach((material) => material.dispose());

    const releaseEnvironmentBindings = [
      studioEnvironment.bindMaterial(graphic, 0.8),
      studioEnvironment.bindMaterial(transparent, 1.05),
      studioEnvironment.bindMaterial(metallic, 1.2),
      studioEnvironment.bindMaterial(anisotrophic, 1.65),
    ];
    return new DiscPrefabRuntime(
      [graphic, transparent, metallic, anisotrophic],
      textureStream,
      releaseEnvironmentBindings,
    );
  }

  dispose(): void {
    this.releaseEnvironmentBindings.forEach((release) => release());
    this.textureStream.dispose();
    this.materials.forEach((material) => material.dispose());
  }
}
