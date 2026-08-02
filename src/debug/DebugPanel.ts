import GUI from 'lil-gui';
import * as THREE from 'three';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import type { SceneRuntime } from '../scene/SceneRuntime';
import type { StudioEnvironmentRuntime } from '../scene/StudioEnvironmentRuntime';
import type { PostProcessingRuntime } from '../postprocessing/PostProcessingRuntime';
import { collectSceneMaterials, serializeMaterial } from './materialEditor';

type EditableLight = THREE.AmbientLight | THREE.DirectionalLight | THREE.HemisphereLight | THREE.PointLight | THREE.SpotLight;
type LightHelper = THREE.Object3D & { update?: () => void; dispose?: () => void };
type EditorSelection = THREE.Object3D | THREE.Material;

interface SerializableObject {
  name: string;
  type: string;
  position: number[];
  rotation: number[];
  scale: number[];
  visible: boolean;
  properties?: Record<string, boolean | number | number[] | string>;
}

function destroyChildren(folder: GUI): void {
  [...folder.children].forEach((child) => child.destroy());
}

function lightProperties(light: EditableLight): Record<string, boolean | number | number[] | string> {
  const properties: Record<string, boolean | number | number[] | string> = {
    color: `#${light.color.getHexString()}`,
    intensity: light.intensity,
  };
  if (light instanceof THREE.PointLight || light instanceof THREE.SpotLight) {
    properties.distance = light.distance;
    properties.decay = light.decay;
    properties.castShadow = light.castShadow;
    properties.shadowBias = light.shadow.bias;
    properties.shadowNormalBias = light.shadow.normalBias;
    properties.shadowMapSize = light.shadow.mapSize.x;
  }
  if (light instanceof THREE.SpotLight) {
    properties.angle = THREE.MathUtils.radToDeg(light.angle);
    properties.penumbra = light.penumbra;
    properties.target = light.target.position.toArray();
  }
  return properties;
}

export class DebugPanel {
  private readonly gui = new GUI({ title: 'LEVEL EDITOR', width: 310 });
  private readonly propertiesGui = new GUI({ title: 'PROPERTIES', width: 310 });
  private readonly objectsFolder = this.gui.addFolder('Objects');
  private readonly lightsFolder = this.gui.addFolder('Lights');
  private readonly materialsFolder = this.gui.addFolder('Materials');
  private readonly transform: TransformControls;
  private readonly editableObjects: THREE.Object3D[];
  private readonly materials: THREE.Material[];
  private readonly lights: EditableLight[] = [];
  private readonly helpers = new Map<EditableLight, LightHelper>();
  private readonly createdLights = new Set<EditableLight>();
  private selected: EditorSelection | null = null;
  private selectedRotationProxy: { x: number; y: number; z: number } | null = null;
  private objectIndex = 0;
  private panelVisible = false;
  private showLightHelpers = true;

  constructor(
    private readonly scene: THREE.Scene,
    private readonly camera: THREE.Camera,
    canvas: HTMLCanvasElement,
    private readonly renderer: THREE.WebGLRenderer,
    private readonly sceneRuntime: SceneRuntime,
    private readonly studioEnvironment: StudioEnvironmentRuntime,
    private readonly postProcessing: PostProcessingRuntime,
  ) {
    this.editableObjects = [...sceneRuntime.bindings.editableObjects];
    this.materials = collectSceneMaterials(scene);
    this.gui.domElement.classList.add('debug-level-panel');
    this.propertiesGui.domElement.classList.add('debug-properties-panel');
    this.transform = new TransformControls(camera, canvas);
    this.transform.addEventListener('objectChange', this.onTransformChanged);
    scene.add(this.transform.getHelper());
    scene.traverse((object) => {
      if (this.isEditableLight(object)) this.registerLight(object);
    });
    this.createPanel();
    this.refreshLists();
    this.select(this.editableObjects[0] ?? this.lights[0] ?? null);
    this.gui.hide();
    this.propertiesGui.hide();
    this.updateHelperVisibility();
  }

  toggle(): void {
    this.panelVisible = !this.panelVisible;
    this.gui.show(this.panelVisible);
    this.propertiesGui.show(this.panelVisible);
    this.updateHelperVisibility();
  }

  dispose(): void {
    this.transform.removeEventListener('objectChange', this.onTransformChanged);
    this.transform.dispose();
    this.transform.getHelper().removeFromParent();
    this.helpers.forEach((helper) => {
      helper.dispose?.();
      helper.removeFromParent();
    });
    this.gui.destroy();
    this.propertiesGui.destroy();
  }

  private createPanel(): void {
    const create = this.gui.addFolder('Create');
    create.add({ pointLight: () => this.addLight('point') }, 'pointLight').name('Point light');
    create.add({ spotLight: () => this.addLight('spot') }, 'spotLight').name('Spot light');
    create.close();

    const level = this.gui.addFolder('Level');
    level.add(this.renderer, 'toneMappingExposure', 0.1, 3, 0.05).name('Exposure');
    level.add(this.studioEnvironment, 'intensity', 0, 3, 0.01).name('Environment');
    level.add(this.studioEnvironment, 'rotationDegrees', -180, 180, 1).name('Env rotation Y');
    const levelState = { showCollision: false, showLightHelpers: this.showLightHelpers };
    level.add(levelState, 'showCollision').name('Show collision').onChange((visible: boolean) => {
      this.sceneRuntime.setCollidersVisible(visible);
    });
    level.add(levelState, 'showLightHelpers').name('Light helpers').onChange((visible: boolean) => {
      this.showLightHelpers = visible;
      this.updateHelperVisibility();
    });
    this.addPerformanceControls(level);
    this.addPostProcessingControls(level);
    level.add({ save: () => void this.saveConfig() }, 'save').name('Save to project');
    level.close();
  }

  private addPerformanceControls(level: GUI): void {
    const folder = level.addFolder('Performance');
    const presetState = { preset: 'Current' as 'Current' | 'Ultra' | 'High' | 'Medium' | 'Low' };
    folder.add(presetState, 'preset', ['Current', 'Ultra', 'High', 'Medium', 'Low']).name('Quality preset')
      .onChange((preset: 'Current' | 'Ultra' | 'High' | 'Medium' | 'Low') => {
        if (preset !== 'Current') this.postProcessing.applyQualityPreset(preset);
      });
    folder.add(this.postProcessing.settings, 'renderScale', 0.5, 1, 0.05).name('Render scale')
      .listen().onChange((scale: number) => this.postProcessing.setRenderScale(scale));
    const diagnostics = this.postProcessing.diagnostics;
    folder.add(diagnostics, 'fps').name('FPS').listen().disable();
    folder.add(diagnostics, 'frameMs').name('Frame ms').listen().disable();
    folder.add(diagnostics, 'drawCalls').name('Draw calls').listen().disable();
    folder.add(diagnostics, 'triangles').name('Triangles').listen().disable();
    folder.add(diagnostics, 'textures').name('GPU textures').listen().disable();
    folder.add(diagnostics, 'programs').name('Programs').listen().disable();
    folder.add(diagnostics, 'renderSize').name('Render size').listen().disable();
    folder.close();
  }

  private addPostProcessingControls(level: GUI): void {
    const settings = this.postProcessing.settings;
    const post = level.addFolder('Post Processing');
    post.add(settings, 'enabled').name('Enabled');

    const antiAliasing = post.addFolder('Anti-aliasing');
    antiAliasing.add(settings.antiAliasing, 'method', ['msaa', 'off']).name('Method').onChange(() => {
      this.postProcessing.rebuild();
    });
    antiAliasing.add(settings.antiAliasing, 'msaaSamples', { Off: 0, '2x': 2, '4x': 4, '8x': 8 })
      .name('MSAA samples')
      .onChange(() => this.postProcessing.rebuild());

    const ambientOcclusion = post.addFolder('Ambient occlusion');
    ambientOcclusion.add(settings.ambientOcclusion, 'enabled').name('Enabled');
    ambientOcclusion.add(settings.ambientOcclusion, 'resolutionScale', {
      'Quarter': 0.25,
      'Half': 0.5,
      'Three quarters': 0.75,
      'Full': 1,
    }).name('Resolution');
    ambientOcclusion.add(settings.ambientOcclusion, 'intensity', 0, 3, 0.01).name('Intensity');
    ambientOcclusion.add(settings.ambientOcclusion, 'radius', 0.01, 2, 0.01).name('Radius');
    ambientOcclusion.add(settings.ambientOcclusion, 'distanceExponent', 0.5, 4, 0.05).name('Distance exponent');
    ambientOcclusion.add(settings.ambientOcclusion, 'thickness', 0.01, 2, 0.01).name('Thickness');
    ambientOcclusion.add(settings.ambientOcclusion, 'distanceFallOff', 0, 2, 0.01).name('Distance falloff');
    ambientOcclusion.add(settings.ambientOcclusion, 'scale', 0.1, 4, 0.05).name('Scale');
    ambientOcclusion.add(settings.ambientOcclusion, 'samples', { Low: 4, Medium: 8, High: 16 }).name('Samples');
    ambientOcclusion.add(settings.ambientOcclusion, 'denoiseRadius', 0, 8, 1).name('Denoise radius');
    ambientOcclusion.add(settings.ambientOcclusion, 'denoiseSamples', { Low: 2, Medium: 4, High: 8 })
      .name('Denoise samples');

    const bloom = post.addFolder('Bloom');
    bloom.add(settings.bloom, 'enabled').name('Enabled');
    bloom.add(settings.bloom, 'strength', 0, 3, 0.01).name('Strength');
    bloom.add(settings.bloom, 'radius', 0, 1, 0.01).name('Radius');
    bloom.add(settings.bloom, 'threshold', 0, 1, 0.01).name('Threshold');

    const flare = post.addFolder('Flare');
    flare.add(settings.flare, 'enabled').name('Enabled');
    const glare = flare.addFolder('Anamorphic glare');
    glare.add(settings.flare.glare, 'enabled').name('Enabled');
    glare.add(settings.flare.glare, 'strength', 0, 2, 0.01).name('Strength');
    glare.add(settings.flare.glare, 'threshold', 0, 1, 0.01).name('Threshold');
    glare.add(settings.flare.glare, 'length', 0.005, 0.35, 0.005).name('Length');
    glare.addColor(settings.flare.glare, 'tint').name('Tint');
    const ghosts = flare.addFolder('Ghosts');
    ghosts.add(settings.flare.ghosts, 'enabled').name('Enabled');
    ghosts.add(settings.flare.ghosts, 'strength', 0, 1, 0.005).name('Strength');
    ghosts.add(settings.flare.ghosts, 'threshold', 0, 1, 0.01).name('Threshold');
    ghosts.add(settings.flare.ghosts, 'spacing', 0.1, 1.5, 0.01).name('Spacing');
    ghosts.add(settings.flare.ghosts, 'chromaticAberration', 0, 0.05, 0.0005).name('Chromatic');
    ghosts.add(settings.flare.ghosts, 'haloStrength', 0, 1, 0.01).name('Halo strength');
    ghosts.add(settings.flare.ghosts, 'haloRadius', 0.05, 0.8, 0.01).name('Halo radius');
    ghosts.addColor(settings.flare.ghosts, 'tint').name('Tint');

    const chromaticAberration = post.addFolder('Chromatic aberration');
    chromaticAberration.add(settings.chromaticAberration, 'enabled').name('Enabled');
    chromaticAberration.add(settings.chromaticAberration, 'amount', 0, 0.025, 0.0001).name('Amount');

    const depthOfField = post.addFolder('Depth of field');
    depthOfField.add(settings.depthOfField, 'enabled').name('Enabled');
    depthOfField.add(settings.depthOfField, 'autofocus').name('Autofocus');
    depthOfField.add(settings.depthOfField, 'focus', 0.05, 20, 0.01).name('Focus distance');
    depthOfField.add(settings.depthOfField, 'focusSpeed', 0.1, 20, 0.1).name('Focus speed');
    depthOfField.add(settings.depthOfField, 'maxDistance', 0.5, 50, 0.1).name('AF max distance');
    depthOfField.add(settings.depthOfField, 'aperture', 0, 0.2, 0.001).name('Aperture');
    depthOfField.add(settings.depthOfField, 'maxBlur', 0, 0.05, 0.0005).name('Max blur');

    const color = post.addFolder('Color grading');
    color.add(settings.color, 'enabled').name('Enabled');
    color.add(settings.color, 'brightness', -0.25, 0.25, 0.001).name('Brightness');
    color.add(settings.color, 'contrast', 0.5, 1.5, 0.001).name('Contrast');
    color.add(settings.color, 'saturation', 0, 2, 0.01).name('Saturation');
    color.add(settings.color, 'gamma', 0.5, 2, 0.01).name('Gamma');
    color.add(settings.color, 'temperature', -1, 1, 0.005).name('Temperature');
    color.add(settings.color, 'tint', -1, 1, 0.005).name('Tint');
    const vignette = color.addFolder('Vignette');
    vignette.add(settings.color.vignette, 'enabled').name('Enabled');
    vignette.add(settings.color.vignette, 'strength', 0, 1, 0.005).name('Strength');
    vignette.add(settings.color.vignette, 'radius', 0.1, 1.5, 0.01).name('Radius');
    vignette.add(settings.color.vignette, 'softness', 0.01, 1, 0.01).name('Softness');
    const grain = color.addFolder('Grain');
    grain.add(settings.color.grain, 'enabled').name('Enabled');
    grain.add(settings.color.grain, 'amount', 0, 0.2, 0.001).name('Amount');

    bloom.close();
    antiAliasing.close();
    ambientOcclusion.close();
    flare.close();
    chromaticAberration.close();
    depthOfField.close();
    color.close();
  }

  private isEditableLight(object: THREE.Object3D): object is EditableLight {
    return object instanceof THREE.AmbientLight
      || object instanceof THREE.DirectionalLight
      || object instanceof THREE.HemisphereLight
      || object instanceof THREE.PointLight
      || object instanceof THREE.SpotLight;
  }

  private registerLight(light: EditableLight): void {
    if (this.lights.includes(light)) return;
    this.lights.push(light);
    if (light instanceof THREE.SpotLight && light.target.parent === null) this.scene.add(light.target);
    const helper = this.createLightHelper(light);
    if (!helper) return;
    helper.visible = false;
    this.helpers.set(light, helper);
    this.scene.add(helper);
  }

  private createLightHelper(light: EditableLight): LightHelper | null {
    if (light instanceof THREE.PointLight) return new THREE.PointLightHelper(light, 0.06, 0x52d9ff);
    if (light instanceof THREE.SpotLight) return new THREE.SpotLightHelper(light, 0x52d9ff);
    if (light instanceof THREE.DirectionalLight) return new THREE.DirectionalLightHelper(light, 0.18, 0x52d9ff);
    if (light instanceof THREE.HemisphereLight) return new THREE.HemisphereLightHelper(light, 0.18, 0x52d9ff);
    return null;
  }

  private addLight(type: 'point' | 'spot'): void {
    const light = type === 'point'
      ? new THREE.PointLight(0xffffff, 2, 3, 2)
      : new THREE.SpotLight(0xffffff, 3, 4, Math.PI / 5, 0.35, 2);
    light.name = `${type === 'point' ? 'Point Light' : 'Spot Light'} ${++this.objectIndex}`;
    light.position.copy(this.camera.position);
    light.castShadow = true;
    light.shadow.mapSize.set(1024, 1024);
    if (light instanceof THREE.SpotLight) {
      const direction = new THREE.Vector3(0, 0, -1).applyQuaternion(this.camera.quaternion);
      light.target.position.copy(light.position).add(direction);
    }
    this.scene.add(light);
    this.createdLights.add(light);
    this.registerLight(light);
    this.refreshLists();
    this.select(light);
  }

  private refreshLists(): void {
    destroyChildren(this.objectsFolder);
    destroyChildren(this.lightsFolder);
    destroyChildren(this.materialsFolder);
    this.editableObjects.forEach((object) => this.addSelectionButton(this.objectsFolder, object));
    this.lights.forEach((light) => this.addSelectionButton(this.lightsFolder, light));
    this.materials.forEach((material) => this.addMaterialSelectionButton(material));
  }

  private addSelectionButton(folder: GUI, object: THREE.Object3D): void {
    const label = object.name || object.type;
    const marker = object === this.selected ? `> ${label}` : label;
    folder.add({ select: () => this.select(object) }, 'select').name(marker);
  }

  private addMaterialSelectionButton(material: THREE.Material): void {
    const label = material.name || material.type;
    const marker = material === this.selected ? `> ${label}` : label;
    this.materialsFolder.add({ select: () => this.select(material) }, 'select').name(marker);
  }

  private select(selection: EditorSelection | null): void {
    this.selected = selection;
    this.refreshLists();
    this.rebuildProperties();
    if (selection instanceof THREE.Object3D
      && !(selection instanceof THREE.AmbientLight)
      && !(selection instanceof THREE.HemisphereLight)) {
      this.transform.attach(selection);
    } else {
      this.transform.detach();
    }
    this.updateHelperVisibility();
  }

  private rebuildProperties(): void {
    destroyChildren(this.propertiesGui);
    this.selectedRotationProxy = null;
    const selection = this.selected;
    if (!selection) {
      this.propertiesGui.add({ selection: 'None' }, 'selection').name('Selected').disable();
      return;
    }
    if (selection instanceof THREE.Material) {
      this.addMaterialProperties(selection);
      return;
    }

    const object = selection;

    const identity = { name: object.name || object.type };
    this.propertiesGui.add(identity, 'name').name('Name').onFinishChange((name: string) => {
      object.name = name.trim() || object.type;
      this.refreshLists();
    });
    this.propertiesGui.add(object, 'visible').name('Visible');

    if (!(object instanceof THREE.AmbientLight) && !(object instanceof THREE.HemisphereLight)) {
      this.addTransformProperties(object);
    }
    if (this.isEditableLight(object)) this.addLightProperties(object);
    if (this.createdLights.has(object as EditableLight)) {
      this.propertiesGui.add({ delete: () => this.deleteSelectedLight() }, 'delete').name('Delete light');
    }
  }

  private addTransformProperties(object: THREE.Object3D): void {
    const tools = this.propertiesGui.addFolder('Transform tool');
    tools.add({ translate: () => this.transform.setMode('translate') }, 'translate').name('Translate');
    tools.add({ rotate: () => this.transform.setMode('rotate') }, 'rotate').name('Rotate');
    tools.add({ scale: () => this.transform.setMode('scale') }, 'scale').name('Scale');

    const position = this.propertiesGui.addFolder('Position');
    position.add(object.position, 'x', -10, 10, 0.001).listen();
    position.add(object.position, 'y', -10, 10, 0.001).listen();
    position.add(object.position, 'z', -10, 10, 0.001).listen();

    this.selectedRotationProxy = {
      x: THREE.MathUtils.radToDeg(object.rotation.x),
      y: THREE.MathUtils.radToDeg(object.rotation.y),
      z: THREE.MathUtils.radToDeg(object.rotation.z),
    };
    const rotation = this.propertiesGui.addFolder('Rotation (deg)');
    (['x', 'y', 'z'] as const).forEach((axis) => {
      rotation.add(this.selectedRotationProxy!, axis, -180, 180, 0.1).onChange((degrees: number) => {
        object.rotation[axis] = THREE.MathUtils.degToRad(degrees);
        this.updateSelectedLightDirection();
        this.updateSelectedHelper();
      });
    });

    const scale = this.propertiesGui.addFolder('Scale');
    scale.add(object.scale, 'x', 0.01, 10, 0.001).listen();
    scale.add(object.scale, 'y', 0.01, 10, 0.001).listen();
    scale.add(object.scale, 'z', 0.01, 10, 0.001).listen();
  }

  private addLightProperties(light: EditableLight): void {
    const lightFolder = this.propertiesGui.addFolder('Light');
    const color = { value: `#${light.color.getHexString()}` };
    lightFolder.addColor(color, 'value').name('Color').onChange((value: string) => {
      light.color.set(value);
      this.updateSelectedHelper();
    });
    lightFolder.add(light, 'intensity', 0, 50, 0.01).name('Intensity').listen();

    if (light instanceof THREE.PointLight || light instanceof THREE.SpotLight) {
      lightFolder.add(light, 'distance', 0, 50, 0.01).name('Distance').listen();
      lightFolder.add(light, 'decay', 0, 4, 0.01).name('Decay').listen();
      lightFolder.add(light, 'castShadow').name('Cast shadow');
      const shadow = this.propertiesGui.addFolder('Shadow');
      shadow.add(light.shadow, 'bias', -0.02, 0.02, 0.00001).name('Bias').listen();
      shadow.add(light.shadow, 'normalBias', -0.1, 0.1, 0.0001).name('Normal bias').listen();
      const shadowMap = { size: light.shadow.mapSize.x };
      shadow.add(shadowMap, 'size', [256, 512, 1024, 2048, 4096]).name('Map size').onChange((size: number) => {
        light.shadow.map?.dispose();
        light.shadow.map = null;
        light.shadow.mapSize.set(size, size);
      });
    }

    if (light instanceof THREE.SpotLight) {
      const spot = this.propertiesGui.addFolder('Spot light');
      const angle = { degrees: THREE.MathUtils.radToDeg(light.angle) };
      spot.add(angle, 'degrees', 1, 89, 0.1).name('Angle').onChange((degrees: number) => {
        light.angle = THREE.MathUtils.degToRad(degrees);
        this.updateSelectedHelper();
      });
      spot.add(light, 'penumbra', 0, 1, 0.01).name('Penumbra').onChange(() => this.updateSelectedHelper());
      const target = spot.addFolder('Target');
      target.add(light.target.position, 'x', -10, 10, 0.001).listen().onChange(() => this.updateSelectedHelper());
      target.add(light.target.position, 'y', -10, 10, 0.001).listen().onChange(() => this.updateSelectedHelper());
      target.add(light.target.position, 'z', -10, 10, 0.001).listen().onChange(() => this.updateSelectedHelper());
    }
  }

  private addMaterialProperties(material: THREE.Material): void {
    const identity = { name: material.name || material.type, type: material.type };
    this.propertiesGui.add(identity, 'name').name('Name').onFinishChange((name: string) => {
      material.name = name.trim() || material.type;
      this.refreshLists();
    });
    this.propertiesGui.add(identity, 'type').name('Type').disable();

    const surface = this.propertiesGui.addFolder('Surface');
    if ('color' in material && material.color instanceof THREE.Color) {
      const materialColor = material.color;
      const color = { value: `#${materialColor.getHexString()}` };
      surface.addColor(color, 'value').name('Color').onChange((value: string) => materialColor.set(value));
    }
    if ('emissive' in material && material.emissive instanceof THREE.Color) {
      const materialEmissive = material.emissive;
      const emissive = { value: `#${materialEmissive.getHexString()}` };
      surface.addColor(emissive, 'value').name('Emissive').onChange((value: string) => materialEmissive.set(value));
    }
    if ('emissiveIntensity' in material && typeof material.emissiveIntensity === 'number') {
      surface.add(material, 'emissiveIntensity', 0, 10, 0.01).name('Emissive power').listen();
    }
    if (material instanceof THREE.MeshStandardMaterial) {
      surface.add(material, 'roughness', 0, 1, 0.001).name('Roughness').listen();
      surface.add(material, 'metalness', 0, 1, 0.001).name('Metalness').listen();
      surface.add(material, 'envMapIntensity', 0, 5, 0.01).name('Environment').listen();
      surface.add(material.normalScale, 'x', -3, 3, 0.01).name('Normal X').listen();
      surface.add(material.normalScale, 'y', -3, 3, 0.01).name('Normal Y').listen();
    }

    const render = this.propertiesGui.addFolder('Rendering');
    render.add(material, 'visible').name('Visible');
    render.add(material, 'opacity', 0, 1, 0.001).name('Opacity').listen();
    render.add(material, 'transparent').name('Transparent').onChange(() => this.refreshMaterial(material));
    render.add(material, 'alphaTest', 0, 1, 0.001).name('Alpha test').onChange(() => this.refreshMaterial(material));
    render.add(material, 'depthTest').name('Depth test');
    render.add(material, 'depthWrite').name('Depth write');
    const sides = { Front: THREE.FrontSide, Back: THREE.BackSide, Double: THREE.DoubleSide };
    render.add(material, 'side', sides).name('Side').onChange(() => this.refreshMaterial(material));
    if ('wireframe' in material && typeof material.wireframe === 'boolean') {
      render.add(material, 'wireframe').name('Wireframe').onChange(() => this.refreshMaterial(material));
    }

    if (material instanceof THREE.MeshPhysicalMaterial) this.addPhysicalMaterialProperties(material);
    this.addTextureSummary(material);
  }

  private addPhysicalMaterialProperties(material: THREE.MeshPhysicalMaterial): void {
    const glass = this.propertiesGui.addFolder('Physical / Glass');
    glass.add(material, 'transmission', 0, 1, 0.001).name('Transmission').listen();
    glass.add(material, 'ior', 1, 2.333, 0.001).name('IOR').listen();
    glass.add(material, 'thickness', 0, 5, 0.001).name('Thickness').listen();
    glass.add(material, 'reflectivity', 0, 1, 0.001).name('Reflectivity').listen();
    glass.add(material, 'clearcoat', 0, 1, 0.001).name('Clearcoat').listen();
    glass.add(material, 'clearcoatRoughness', 0, 1, 0.001).name('Coat roughness').listen();
    const attenuation = { value: `#${material.attenuationColor.getHexString()}` };
    glass.addColor(attenuation, 'value').name('Attenuation').onChange((value: string) => {
      material.attenuationColor.set(value);
    });
    glass.add(material, 'attenuationDistance', 0, 20, 0.01).name('Atten. distance').listen();

    const reflections = this.propertiesGui.addFolder('Physical / Reflections');
    reflections.add(material, 'anisotropy', 0, 1, 0.001).name('Anisotropy').listen()
      .onChange(() => this.refreshMaterial(material));
    const anisotropyRotation = { degrees: THREE.MathUtils.radToDeg(material.anisotropyRotation) };
    reflections.add(anisotropyRotation, 'degrees', -180, 180, 0.1).name('Anisotropy angle').onChange((value: number) => {
      material.anisotropyRotation = THREE.MathUtils.degToRad(value);
    });
    reflections.add(material, 'iridescence', 0, 1, 0.001).name('Iridescence').listen()
      .onChange(() => this.refreshMaterial(material));
    reflections.add(material, 'iridescenceIOR', 1, 2.333, 0.001).name('Iridescence IOR').listen();
    const thicknessRange = {
      minimum: material.iridescenceThicknessRange[0],
      maximum: material.iridescenceThicknessRange[1],
    };
    reflections.add(thicknessRange, 'minimum', 0, 1200, 1).name('Iridescence min').onChange((value: number) => {
      material.iridescenceThicknessRange[0] = Math.min(value, material.iridescenceThicknessRange[1]);
    });
    reflections.add(thicknessRange, 'maximum', 0, 1200, 1).name('Iridescence max').onChange((value: number) => {
      material.iridescenceThicknessRange[1] = Math.max(value, material.iridescenceThicknessRange[0]);
    });
    reflections.add(material, 'specularIntensity', 0, 1, 0.001).name('Specular').listen();
    const specularColor = { value: `#${material.specularColor.getHexString()}` };
    reflections.addColor(specularColor, 'value').name('Specular color').onChange((value: string) => {
      material.specularColor.set(value);
    });
  }

  private addTextureSummary(material: THREE.Material): void {
    const textureSlots = [
      'map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'emissiveMap',
      'alphaMap', 'transmissionMap', 'thicknessMap', 'anisotropyMap', 'iridescenceMap',
      'iridescenceThicknessMap', 'clearcoatMap', 'clearcoatRoughnessMap', 'envMap',
    ] as const;
    const assigned = textureSlots.flatMap((slot) => {
      if (!(slot in material)) return [];
      const texture = material[slot as keyof THREE.Material];
      if (!(texture instanceof THREE.Texture)) return [];
      return [{ slot, texture }];
    });
    if (assigned.length === 0) return;
    const maps = this.propertiesGui.addFolder('Texture maps');
    assigned.forEach(({ slot, texture }) => {
      const source = texture.name || texture.source.data?.currentSrc || texture.source.data?.src || 'Assigned';
      maps.add({ value: source }, 'value').name(slot).disable();
    });
    maps.close();
  }

  private refreshMaterial(material: THREE.Material): void {
    material.needsUpdate = true;
  }

  private readonly onTransformChanged = (): void => {
    this.renderer.shadowMap.needsUpdate = true;
    if (this.selectedRotationProxy && this.selected instanceof THREE.Object3D) {
      this.selectedRotationProxy.x = THREE.MathUtils.radToDeg(this.selected.rotation.x);
      this.selectedRotationProxy.y = THREE.MathUtils.radToDeg(this.selected.rotation.y);
      this.selectedRotationProxy.z = THREE.MathUtils.radToDeg(this.selected.rotation.z);
    }
    this.updateSelectedLightDirection();
    this.updateSelectedHelper();
  };

  private updateSelectedLightDirection(): void {
    if (!(this.selected instanceof THREE.SpotLight) || this.transform.getMode() !== 'rotate') return;
    const direction = new THREE.Vector3(0, 0, -1).applyQuaternion(this.selected.quaternion);
    this.selected.target.position.copy(this.selected.position).add(direction);
  }

  private updateSelectedHelper(): void {
    if (!(this.selected instanceof THREE.Object3D) || !this.isEditableLight(this.selected)) return;
    this.helpers.get(this.selected)?.update?.();
  }

  private updateHelperVisibility(): void {
    this.transform.getHelper().visible = this.panelVisible
      && this.selected instanceof THREE.Object3D
      && !(this.selected instanceof THREE.AmbientLight)
      && !(this.selected instanceof THREE.HemisphereLight);
    this.helpers.forEach((helper, light) => {
      helper.visible = this.panelVisible && this.showLightHelpers && light.visible;
      helper.update?.();
    });
  }

  private deleteSelectedLight(): void {
    if (!(this.selected instanceof THREE.Object3D)
      || !this.isEditableLight(this.selected)
      || !this.createdLights.has(this.selected)) return;
    const light = this.selected;
    const helper = this.helpers.get(light);
    helper?.dispose?.();
    helper?.removeFromParent();
    this.helpers.delete(light);
    if (light instanceof THREE.SpotLight || light instanceof THREE.DirectionalLight) {
      light.target.removeFromParent();
    }
    light.removeFromParent();
    this.createdLights.delete(light);
    this.lights.splice(this.lights.indexOf(light), 1);
    this.select(this.editableObjects[0] ?? this.lights[0] ?? null);
  }

  private async saveConfig(): Promise<void> {
    const objects: SerializableObject[] = [...this.editableObjects, ...this.lights].map((object) => {
      const serialized: SerializableObject = {
        name: object.name || object.type,
        type: object.type,
        position: object.position.toArray(),
        rotation: [object.rotation.x, object.rotation.y, object.rotation.z],
        scale: object.scale.toArray(),
        visible: object.visible,
      };
      if (this.isEditableLight(object)) serialized.properties = lightProperties(object);
      return serialized;
    });
    const config = {
      level: {
        exposure: this.renderer.toneMappingExposure,
        environmentIntensity: this.studioEnvironment.intensity,
        environmentRotationY: this.studioEnvironment.rotationDegrees,
      },
      objects,
      materials: this.materials.map(serializeMaterial),
      postProcessing: this.postProcessing.settings,
    };
    try {
      const response = await fetch('/__save-level-config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config, null, 2),
      });
      const result = await response.json() as { error?: string; ok?: boolean };
      if (!response.ok || !result.ok) throw new Error(result.error ?? 'Unable to save level config.');
      this.gui.title('LEVEL EDITOR - SAVED');
      window.setTimeout(() => this.gui.title('LEVEL EDITOR'), 1200);
    } catch (error) {
      console.error('[Level editor] Save failed', error);
      this.gui.title('LEVEL EDITOR - SAVE FAILED');
      window.setTimeout(() => this.gui.title('LEVEL EDITOR'), 1800);
    }
  }
}
