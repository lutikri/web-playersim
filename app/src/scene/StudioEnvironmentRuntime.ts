import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';

interface MaterialBinding {
  material: THREE.MeshStandardMaterial;
  multiplier: number;
}

export class StudioEnvironmentRuntime {
  private readonly renderTarget: THREE.WebGLRenderTarget;
  private readonly bindings = new Set<MaterialBinding>();
  private intensityValue = 1;
  private rotationDegreesValue = 24;

  constructor(renderer: THREE.WebGLRenderer, private readonly scene: THREE.Scene) {
    const room = new RoomEnvironment();
    const pmrem = new THREE.PMREMGenerator(renderer);
    pmrem.compileCubemapShader();
    this.renderTarget = pmrem.fromScene(room, 0.04);
    room.dispose();
    pmrem.dispose();
    scene.environment = this.renderTarget.texture;
    this.updateScene();
  }

  get intensity(): number {
    return this.intensityValue;
  }

  set intensity(value: number) {
    this.intensityValue = value;
    this.updateBindings();
  }

  get rotationDegrees(): number {
    return this.rotationDegreesValue;
  }

  set rotationDegrees(value: number) {
    this.rotationDegreesValue = value;
    this.updateBindings();
  }

  bindMaterial(material: THREE.MeshStandardMaterial, multiplier = 1): () => void {
    const binding = { material, multiplier };
    material.envMap = this.renderTarget.texture;
    this.bindings.add(binding);
    this.updateMaterial(binding);
    material.needsUpdate = true;
    return () => {
      this.bindings.delete(binding);
      if (material.envMap === this.renderTarget.texture) material.envMap = null;
      material.needsUpdate = true;
    };
  }

  dispose(): void {
    this.bindings.forEach(({ material }) => {
      if (material.envMap === this.renderTarget.texture) material.envMap = null;
      material.needsUpdate = true;
    });
    this.bindings.clear();
    if (this.scene.environment === this.renderTarget.texture) this.scene.environment = null;
    this.renderTarget.dispose();
  }

  private updateBindings(): void {
    this.updateScene();
    this.bindings.forEach((binding) => this.updateMaterial(binding));
  }

  private updateScene(): void {
    this.scene.environmentIntensity = this.intensityValue;
    this.scene.environmentRotation.y = THREE.MathUtils.degToRad(this.rotationDegreesValue);
  }

  private updateMaterial({ material, multiplier }: MaterialBinding): void {
    material.envMapIntensity = this.intensityValue * multiplier;
    material.envMapRotation.y = THREE.MathUtils.degToRad(this.rotationDegreesValue);
  }
}
