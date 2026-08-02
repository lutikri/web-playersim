import * as THREE from 'three';
import type { SerializableMaterial, SerializedMaterialValue } from '../debug/materialEditor';
import { collectSceneMaterials } from '../debug/materialEditor';
import type { PostProcessingOverrides } from '../postprocessing/PostProcessingRuntime';
import type { StudioEnvironmentRuntime } from '../scene/StudioEnvironmentRuntime';

export interface ConfiguredObject {
  name: string;
  type: string;
  position: number[];
  rotation: number[];
  scale: number[];
  visible: boolean;
  properties?: Record<string, boolean | number | number[] | string | null>;
}

export interface LevelConfig {
  level?: {
    exposure?: number;
    environmentIntensity?: number;
    environmentRotationY?: number;
  };
  objects?: ConfiguredObject[];
  materials?: SerializableMaterial[];
  postProcessing?: PostProcessingOverrides;
}

interface LevelConfigTargets {
  scene: THREE.Scene;
  renderer: THREE.WebGLRenderer;
  studioEnvironment: StudioEnvironmentRuntime;
}

type EditableLight = THREE.AmbientLight | THREE.DirectionalLight | THREE.HemisphereLight | THREE.PointLight | THREE.SpotLight;

function isEditableLight(object: THREE.Object3D): object is EditableLight {
  return object instanceof THREE.AmbientLight
    || object instanceof THREE.DirectionalLight
    || object instanceof THREE.HemisphereLight
    || object instanceof THREE.PointLight
    || object instanceof THREE.SpotLight;
}

function applyTransform(object: THREE.Object3D, config: ConfiguredObject): void {
  if (config.position.length >= 3) object.position.fromArray(config.position);
  if (config.rotation.length >= 3) object.rotation.set(config.rotation[0], config.rotation[1], config.rotation[2]);
  if (config.scale.length >= 3) object.scale.fromArray(config.scale);
  object.visible = config.visible;
}

function applyLightProperties(light: EditableLight, properties: ConfiguredObject['properties']): void {
  if (!properties) return;
  if (typeof properties.color === 'string') light.color.set(properties.color);
  if (typeof properties.intensity === 'number') light.intensity = properties.intensity;
  if (light instanceof THREE.PointLight || light instanceof THREE.SpotLight) {
    if (typeof properties.distance === 'number') light.distance = properties.distance;
    if (typeof properties.decay === 'number') light.decay = properties.decay;
    if (typeof properties.castShadow === 'boolean') light.castShadow = properties.castShadow;
    if (typeof properties.shadowBias === 'number') light.shadow.bias = properties.shadowBias;
    if (typeof properties.shadowNormalBias === 'number') light.shadow.normalBias = properties.shadowNormalBias;
    if (typeof properties.shadowMapSize === 'number') {
      light.shadow.mapSize.set(properties.shadowMapSize, properties.shadowMapSize);
    }
  }
  if (light instanceof THREE.SpotLight) {
    if (typeof properties.angle === 'number') light.angle = THREE.MathUtils.degToRad(properties.angle);
    if (typeof properties.penumbra === 'number') light.penumbra = properties.penumbra;
    if (Array.isArray(properties.target) && properties.target.length >= 3) {
      light.target.position.fromArray(properties.target);
    }
  }
}

function createConfiguredLight(config: ConfiguredObject): EditableLight | null {
  if (config.type === 'PointLight') return new THREE.PointLight();
  if (config.type === 'SpotLight') return new THREE.SpotLight();
  return null;
}

function setMaterialProperty(material: THREE.Material, key: string, value: SerializedMaterialValue): void {
  if (value === undefined || !(key in material)) return;
  const current = material[key as keyof THREE.Material];
  if (current instanceof THREE.Color && typeof value === 'string') {
    current.set(value);
    return;
  }
  if (Array.isArray(current) && Array.isArray(value)) {
    current.splice(0, current.length, ...value);
    return;
  }
  if (key === 'attenuationDistance' && value === null) {
    (material as THREE.MeshPhysicalMaterial).attenuationDistance = Infinity;
    return;
  }
  if (typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') {
    Object.assign(material, { [key]: value });
  }
}

function applyMaterials(scene: THREE.Scene, configs: SerializableMaterial[]): void {
  const available = new Map<string, THREE.Material[]>();
  collectSceneMaterials(scene).forEach((material) => {
    const key = `${material.name || material.type}\u0000${material.type}`;
    const matches = available.get(key) ?? [];
    matches.push(material);
    available.set(key, matches);
  });
  const offsets = new Map<string, number>();
  configs.forEach((config) => {
    const key = `${config.name}\u0000${config.type}`;
    const offset = offsets.get(key) ?? 0;
    const material = available.get(key)?.[offset];
    offsets.set(key, offset + 1);
    if (!material) return;
    Object.entries(config.properties).forEach(([property, value]) => setMaterialProperty(material, property, value));
    material.needsUpdate = true;
  });
}

export function applyLevelConfig(config: LevelConfig, targets: LevelConfigTargets): void {
  const { scene, renderer, studioEnvironment } = targets;
  if (typeof config.level?.exposure === 'number') renderer.toneMappingExposure = config.level.exposure;
  if (typeof config.level?.environmentIntensity === 'number') {
    studioEnvironment.intensity = config.level.environmentIntensity;
  }
  if (typeof config.level?.environmentRotationY === 'number') {
    studioEnvironment.rotationDegrees = config.level.environmentRotationY;
  }

  config.objects?.forEach((objectConfig) => {
    let object = scene.getObjectByName(objectConfig.name);
    if (!object) {
      const createdLight = createConfiguredLight(objectConfig);
      if (!createdLight) return;
      createdLight.name = objectConfig.name;
      scene.add(createdLight);
      if (createdLight instanceof THREE.SpotLight) scene.add(createdLight.target);
      object = createdLight;
    }
    applyTransform(object, objectConfig);
    if (isEditableLight(object)) applyLightProperties(object, objectConfig.properties);
  });
  if (config.materials) applyMaterials(scene, config.materials);
}
