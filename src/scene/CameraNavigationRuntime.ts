import * as THREE from 'three';
import type { CameraPose, CameraRuntime } from './CameraRuntime';

const SECONDARY_CAMERAS = [
  ['CAM_PlayerFront', 'Player front'],
  ['CAM_SpeakerLeft', 'Left speaker'],
  ['CAM_SpeakerRight', 'Right speaker'],
] as const;

interface HotspotBinding {
  hint: THREE.Object3D;
  button: HTMLButtonElement;
}

export class CameraNavigationRuntime {
  private readonly hotspots: HotspotBinding[] = [];
  private readonly guided: boolean;
  private debugMode = false;

  constructor(
    private readonly camera: THREE.PerspectiveCamera,
    private readonly cameraRuntime: CameraRuntime,
    poses: readonly CameraPose[],
    hints: readonly THREE.Object3D[],
    private readonly root: HTMLElement,
    private readonly hotspotRoot: HTMLElement,
    private readonly backButton: HTMLButtonElement,
  ) {
    this.guided = cameraRuntime.configureGuidedCamera(poses);
    SECONDARY_CAMERAS.forEach(([name, label]) => {
      const pose = poses.find((candidate) => candidate.name === name);
      const hintName = name.replace('CAM_', 'CAMHINT_');
      const hint = hints.find((candidate) => candidate.name === hintName);
      if (!pose || !hint) return;
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'camera-hotspot';
      button.title = label;
      button.setAttribute('aria-label', label);
      button.addEventListener('click', () => cameraRuntime.goToPose(name));
      hotspotRoot.append(button);
      this.hotspots.push({ hint, button });
    });
    backButton.addEventListener('click', this.onBack);
    root.classList.toggle('is-unavailable', !this.guided);
    this.update();
  }

  get isGuided(): boolean {
    return this.guided;
  }

  playIntro(): void {
    if (this.guided && !this.debugMode) this.cameraRuntime.goToPose('CAM_Overview', 5);
  }

  setDebugMode(enabled: boolean): void {
    this.debugMode = enabled;
    this.root.classList.toggle('is-debug', enabled);
    this.cameraRuntime.setFreeCameraMode(enabled || !this.guided);
    if (!enabled && this.guided) this.cameraRuntime.goToPose('CAM_Overview', 1.2);
  }

  update(): void {
    const current = this.cameraRuntime.currentPoseName;
    const showHotspots = this.guided
      && !this.debugMode
      && !this.cameraRuntime.isTransitioning
      && current === 'CAM_Overview';
    this.hotspotRoot.classList.toggle('is-visible', showHotspots);
    this.hotspots.forEach(({ hint, button }) => this.placeHotspot(hint, button, showHotspots));
    const showBack = this.guided
      && !this.debugMode
      && !this.cameraRuntime.isTransitioning
      && current !== null
      && current !== 'CAM_Start'
      && current !== 'CAM_Overview';
    this.backButton.classList.toggle('is-visible', showBack);
  }

  dispose(): void {
    this.backButton.removeEventListener('click', this.onBack);
    this.hotspots.forEach(({ button }) => button.remove());
    this.hotspots.length = 0;
  }

  private placeHotspot(hint: THREE.Object3D, button: HTMLButtonElement, enabled: boolean): void {
    if (!enabled) {
      button.hidden = true;
      return;
    }
    hint.updateWorldMatrix(true, false);
    const projected = hint.getWorldPosition(new THREE.Vector3()).project(this.camera);
    const inView = projected.z > -1 && projected.z < 1
      && Math.abs(projected.x) < 0.96
      && Math.abs(projected.y) < 0.94;
    button.hidden = !inView;
    if (!inView) return;
    button.style.left = `${(projected.x * 0.5 + 0.5) * 100}%`;
    button.style.top = `${(-projected.y * 0.5 + 0.5) * 100}%`;
  }

  private readonly onBack = (): void => {
    this.cameraRuntime.goToPose('CAM_Overview', 1.6);
  };
}
