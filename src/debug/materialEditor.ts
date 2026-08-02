import * as THREE from 'three';

export type SerializedMaterialValue = boolean | number | number[] | string | null;

export interface SerializableMaterial {
  uuid: string;
  name: string;
  type: string;
  properties: Record<string, SerializedMaterialValue>;
}

export function collectSceneMaterials(root: THREE.Object3D): THREE.Material[] {
  const materials = new Set<THREE.Material>();
  root.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    const assigned = Array.isArray(object.material) ? object.material : [object.material];
    assigned.forEach((material) => materials.add(material));
  });
  return [...materials];
}

export function serializeMaterial(material: THREE.Material): SerializableMaterial {
  const properties: Record<string, SerializedMaterialValue> = {
    visible: material.visible,
    opacity: material.opacity,
    transparent: material.transparent,
    alphaTest: material.alphaTest,
    depthTest: material.depthTest,
    depthWrite: material.depthWrite,
    side: material.side,
  };

  if ('color' in material && material.color instanceof THREE.Color) {
    properties.color = `#${material.color.getHexString()}`;
  }
  if (material instanceof THREE.MeshStandardMaterial) {
    properties.roughness = material.roughness;
    properties.metalness = material.metalness;
    properties.envMapIntensity = material.envMapIntensity;
    properties.emissive = `#${material.emissive.getHexString()}`;
    properties.emissiveIntensity = material.emissiveIntensity;
  }
  if (material instanceof THREE.MeshPhysicalMaterial) {
    properties.transmission = material.transmission;
    properties.ior = material.ior;
    properties.thickness = material.thickness;
    properties.attenuationColor = `#${material.attenuationColor.getHexString()}`;
    properties.attenuationDistance = material.attenuationDistance;
    properties.clearcoat = material.clearcoat;
    properties.clearcoatRoughness = material.clearcoatRoughness;
  }

  return {
    uuid: material.uuid,
    name: material.name || material.type,
    type: material.type,
    properties,
  };
}
