import * as THREE from 'three';
import type { CameraPose, CameraRuntime } from './CameraRuntime';

const PRIMARY_CAMERAS = new Set(['CAM_Start', 'CAM_Overview']);

function cameraLabel(name: string): string {
  return name
    .replace(/^CAM_/, '')
    .replace(/([a-z])([A-Z])/g, '$1 $2');
}

function findCameraHint(name: string, hints: readonly THREE.Object3D[]): THREE.Object3D | undefined {
  const expected = name.replace('CAM_', 'CAMHINT_');
  const aliases = name === 'CAM_PlayerTop'
    ? [expected, 'CAMHINT_SpeakerRightTop', 'CAM_SpeakerRightTop']
    : [expected];
  return aliases.map((alias) => hints.find((candidate) => candidate.name === alias)).find(Boolean);
}

interface HotspotBinding {
  hint: THREE.Object3D;
  button: HTMLButtonElement;
}

const HOTSPOT_EDGE_X = 0.94;
const HOTSPOT_EDGE_Y = 0.9;

export function clampHotspotToEdge(
  projected: THREE.Vector3,
  behindCamera: boolean,
): { position: THREE.Vector2; offscreen: boolean } {
  const position = new THREE.Vector2(projected.x, projected.y);
  if (behindCamera) position.multiplyScalar(-1);
  const inView = !behindCamera
    && projected.z > -1
    && projected.z < 1
    && Math.abs(position.x) <= HOTSPOT_EDGE_X
    && Math.abs(position.y) <= HOTSPOT_EDGE_Y;
  if (inView) return { position, offscreen: false };
  if (!Number.isFinite(position.x) || !Number.isFinite(position.y)) position.set(0, -1);
  if (position.lengthSq() < 1e-6) position.set(0, -1);
  const edgeScale = Math.min(
    HOTSPOT_EDGE_X / Math.max(Math.abs(position.x), 1e-6),
    HOTSPOT_EDGE_Y / Math.max(Math.abs(position.y), 1e-6),
  );
  position.multiplyScalar(edgeScale);
  return { position, offscreen: true };
}

export class CameraNavigationRuntime {
  private readonly hotspots: HotspotBinding[] = [];
  private readonly guided: boolean;
  private debugMode = false;
  private readonly cameraSpacePosition = new THREE.Vector3();
  private readonly projectedPosition = new THREE.Vector3();

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
    poses.filter((pose) => !PRIMARY_CAMERAS.has(pose.name)).forEach((pose) => {
      const name = pose.name;
      const label = cameraLabel(name);
      const hint = findCameraHint(name, hints);
      if (!hint) return;
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'camera-hotspot';
      button.title = label;
      button.setAttribute('aria-label', label);
      button.dataset.camera = name;
      button.addEventListener('pointerdown', (event) => {
        console.info('[Input debug] hotspot pointerdown', {
          camera: name,
          client: [event.clientX, event.clientY],
          offscreen: button.classList.contains('is-offscreen'),
        });
      });
      button.addEventListener('click', () => {
        const accepted = cameraRuntime.goToPose(name);
        console.info('[Input debug] hotspot click', { camera: name, accepted });
      });
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
    this.camera.updateMatrixWorld();
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
    hint.getWorldPosition(this.projectedPosition);
    this.cameraSpacePosition.copy(this.projectedPosition).applyMatrix4(this.camera.matrixWorldInverse);
    this.projectedPosition.project(this.camera);
    const placement = clampHotspotToEdge(this.projectedPosition, this.cameraSpacePosition.z >= 0);
    button.hidden = false;
    button.classList.toggle('is-offscreen', placement.offscreen);
    button.style.left = `${(placement.position.x * 0.5 + 0.5) * 100}%`;
    button.style.top = `${(-placement.position.y * 0.5 + 0.5) * 100}%`;
  }

  private readonly onBack = (): void => {
    this.cameraRuntime.goToPose('CAM_Overview', 1.6);
  };
}
