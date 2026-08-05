import * as THREE from 'three';

export interface CameraPose {
  name: string;
  camera: THREE.PerspectiveCamera;
}

interface CameraTransition {
  elapsed: number;
  duration: number;
  fromPosition: THREE.Vector3;
  fromQuaternion: THREE.Quaternion;
  fromFov: number;
  toPosition: THREE.Vector3;
  toQuaternion: THREE.Quaternion;
  toFov: number;
  targetName: string;
}

const PARALLAX_YAW = THREE.MathUtils.degToRad(2.2);
const PARALLAX_PITCH = THREE.MathUtils.degToRad(1.35);

export function coverFov(authoredFov: number, authoredAspect: number, viewportAspect: number): number {
  if (viewportAspect <= authoredAspect || authoredAspect <= 0) return authoredFov;
  const halfFov = THREE.MathUtils.degToRad(authoredFov) * 0.5;
  return THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(halfFov) * authoredAspect / viewportAspect));
}

function easeInOut(value: number): number {
  const t = THREE.MathUtils.clamp(value, 0, 1);
  return t * t * t * (t * (t * 6 - 15) + 10);
}

export class CameraRuntime {
  private readonly keys = new Set<string>();
  private readonly poses = new Map<string, THREE.PerspectiveCamera>();
  private yaw = 0;
  private pitch = -0.18;
  private looking = false;
  private inputEnabled = true;
  private freeCameraMode = true;
  private transition: CameraTransition | null = null;
  private currentPoseNameValue: string | null = null;
  private readonly guidedBasePosition = new THREE.Vector3();
  private readonly guidedBaseQuaternion = new THREE.Quaternion();
  private readonly parallaxTarget = new THREE.Vector2();
  private readonly parallaxCurrent = new THREE.Vector2();
  private readonly parallaxEuler = new THREE.Euler(0, 0, 0, 'YXZ');
  private readonly parallaxQuaternion = new THREE.Quaternion();

  constructor(
    private readonly camera: THREE.PerspectiveCamera,
    private readonly canvas: HTMLCanvasElement,
  ) {
    camera.position.set(0.92, 0.4, 0.62);
    camera.rotation.order = 'YXZ';
    camera.lookAt(0, 0.055, 0);
    this.syncFreeLookAngles();
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.onBlur);
    window.addEventListener('pointermove', this.onPointerMove);
    canvas.addEventListener('pointerdown', this.onPointerDown);
    canvas.addEventListener('pointerup', this.onPointerUp);
    canvas.addEventListener('pointercancel', this.onPointerUp);
    canvas.addEventListener('contextmenu', this.preventContextMenu);
  }

  get currentPoseName(): string | null {
    return this.currentPoseNameValue;
  }

  get isTransitioning(): boolean {
    return this.transition !== null;
  }

  get isFreeCamera(): boolean {
    return this.freeCameraMode;
  }

  configureGuidedCamera(poses: readonly CameraPose[]): boolean {
    this.poses.clear();
    poses.forEach((pose) => this.poses.set(pose.name, pose.camera));
    const start = this.poses.get('CAM_Start');
    const overview = this.poses.get('CAM_Overview');
    if (!start || !overview) {
      this.freeCameraMode = true;
      return false;
    }
    this.freeCameraMode = false;
    this.applyPose(start);
    this.currentPoseNameValue = 'CAM_Start';
    return true;
  }

  setEnabled(enabled: boolean): void {
    this.inputEnabled = enabled;
    if (!enabled) this.looking = false;
  }

  setFreeCameraMode(enabled: boolean): void {
    this.freeCameraMode = enabled;
    this.transition = null;
    this.currentPoseNameValue = null;
    this.looking = false;
    this.parallaxTarget.set(0, 0);
    this.parallaxCurrent.set(0, 0);
    this.syncFreeLookAngles();
  }

  goToPose(name: string, durationSeconds = 1.5): boolean {
    const pose = this.poses.get(name);
    if (!pose || this.freeCameraMode) return false;
    pose.updateWorldMatrix(true, false);
    const toPosition = pose.getWorldPosition(new THREE.Vector3());
    const toQuaternion = pose.getWorldQuaternion(new THREE.Quaternion());
    this.transition = {
      elapsed: 0,
      duration: Math.max(durationSeconds, 0.001),
      fromPosition: this.guidedBasePosition.clone(),
      fromQuaternion: this.guidedBaseQuaternion.clone(),
      fromFov: this.camera.fov,
      toPosition,
      toQuaternion,
      toFov: this.poseFov(pose),
      targetName: name,
    };
    this.currentPoseNameValue = null;
    return true;
  }

  update(deltaSeconds: number): void {
    if (this.transition) {
      this.updateTransition(deltaSeconds);
      this.updateParallax(deltaSeconds);
      return;
    }
    if (!this.freeCameraMode) {
      this.updateParallax(deltaSeconds);
      return;
    }
    if (!this.inputEnabled) return;
    const speed = (this.keys.has('ShiftLeft') ? 0.9 : 0.42) * deltaSeconds;
    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(this.camera.quaternion);
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(this.camera.quaternion);
    if (this.keys.has('KeyW')) this.camera.position.addScaledVector(forward, speed);
    if (this.keys.has('KeyS')) this.camera.position.addScaledVector(forward, -speed);
    if (this.keys.has('KeyA')) this.camera.position.addScaledVector(right, -speed);
    if (this.keys.has('KeyD')) this.camera.position.addScaledVector(right, speed);
    if (this.keys.has('KeyQ')) this.camera.position.y -= speed;
    if (this.keys.has('KeyE')) this.camera.position.y += speed;
  }

  dispose(): void {
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('blur', this.onBlur);
    window.removeEventListener('pointermove', this.onPointerMove);
    this.canvas.removeEventListener('pointerdown', this.onPointerDown);
    this.canvas.removeEventListener('pointerup', this.onPointerUp);
    this.canvas.removeEventListener('pointercancel', this.onPointerUp);
    this.canvas.removeEventListener('contextmenu', this.preventContextMenu);
  }

  private applyPose(pose: THREE.PerspectiveCamera): void {
    pose.updateWorldMatrix(true, false);
    pose.getWorldPosition(this.guidedBasePosition);
    pose.getWorldQuaternion(this.guidedBaseQuaternion);
    this.camera.position.copy(this.guidedBasePosition);
    this.camera.quaternion.copy(this.guidedBaseQuaternion);
    this.camera.fov = this.poseFov(pose);
    this.camera.near = pose.near;
    this.camera.far = pose.far;
    this.camera.updateProjectionMatrix();
  }

  resize(): void {
    if (this.freeCameraMode || this.transition || !this.currentPoseNameValue) return;
    const pose = this.poses.get(this.currentPoseNameValue);
    if (!pose) return;
    this.camera.fov = this.poseFov(pose);
    this.camera.updateProjectionMatrix();
  }

  private updateTransition(deltaSeconds: number): void {
    const transition = this.transition;
    if (!transition) return;
    transition.elapsed += deltaSeconds;
    const progress = Math.min(transition.elapsed / transition.duration, 1);
    const eased = easeInOut(progress);
    this.guidedBasePosition.lerpVectors(transition.fromPosition, transition.toPosition, eased);
    this.guidedBaseQuaternion.slerpQuaternions(transition.fromQuaternion, transition.toQuaternion, eased);
    this.camera.fov = THREE.MathUtils.lerp(transition.fromFov, transition.toFov, eased);
    this.camera.updateProjectionMatrix();
    if (progress < 1) return;
    this.guidedBasePosition.copy(transition.toPosition);
    this.guidedBaseQuaternion.copy(transition.toQuaternion);
    this.currentPoseNameValue = transition.targetName;
    this.transition = null;
  }

  private syncFreeLookAngles(): void {
    this.camera.rotation.order = 'YXZ';
    this.yaw = this.camera.rotation.y;
    this.pitch = this.camera.rotation.x;
  }

  private poseFov(pose: THREE.PerspectiveCamera): number {
    return coverFov(pose.fov, pose.aspect, this.camera.aspect);
  }

  private updateParallax(deltaSeconds: number): void {
    if (this.inputEnabled) {
      this.parallaxCurrent.lerp(this.parallaxTarget, 1 - Math.exp(-5.5 * deltaSeconds));
    }
    this.parallaxEuler.set(
      this.parallaxCurrent.y * PARALLAX_PITCH,
      -this.parallaxCurrent.x * PARALLAX_YAW,
      0,
      'YXZ',
    );
    this.parallaxQuaternion.setFromEuler(this.parallaxEuler);
    this.camera.position.copy(this.guidedBasePosition);
    this.camera.quaternion.copy(this.guidedBaseQuaternion).multiply(this.parallaxQuaternion);
  }

  private readonly onKeyDown = (event: KeyboardEvent): void => { this.keys.add(event.code); };
  private readonly onKeyUp = (event: KeyboardEvent): void => { this.keys.delete(event.code); };
  private readonly onBlur = (): void => {
    this.keys.clear();
    this.looking = false;
    this.parallaxTarget.set(0, 0);
  };
  private readonly preventContextMenu = (event: MouseEvent): void => { event.preventDefault(); };
  private readonly onPointerDown = (event: PointerEvent): void => {
    if (event.button !== 2 || !this.inputEnabled || !this.freeCameraMode) return;
    this.looking = true;
    this.canvas.setPointerCapture(event.pointerId);
  };
  private readonly onPointerUp = (event: PointerEvent): void => {
    if (event.button !== 2) return;
    this.looking = false;
    if (this.canvas.hasPointerCapture(event.pointerId)) this.canvas.releasePointerCapture(event.pointerId);
  };
  private readonly onPointerMove = (event: PointerEvent): void => {
    if (!this.freeCameraMode) {
      if (!this.inputEnabled) return;
      const bounds = this.canvas.getBoundingClientRect();
      this.parallaxTarget.set(
        THREE.MathUtils.clamp(((event.clientX - bounds.left) / bounds.width) * 2 - 1, -1, 1),
        THREE.MathUtils.clamp(1 - ((event.clientY - bounds.top) / bounds.height) * 2, -1, 1),
      );
      return;
    }
    if (this.inputEnabled && this.looking) {
      this.yaw -= event.movementX * 0.0025;
      this.pitch = THREE.MathUtils.clamp(this.pitch - event.movementY * 0.0025, -1.45, 1.45);
      this.camera.rotation.set(this.pitch, this.yaw, 0, 'YXZ');
    }
  };
}
