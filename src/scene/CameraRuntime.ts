import * as THREE from 'three';

export class CameraRuntime {
  private readonly keys = new Set<string>();
  private yaw = 0;
  private pitch = -0.18;
  private looking = false;
  private enabled = true;

  constructor(
    private readonly camera: THREE.PerspectiveCamera,
    private readonly canvas: HTMLCanvasElement,
  ) {
    camera.position.set(0.92, 0.4, 0.62);
    camera.rotation.order = 'YXZ';
    camera.lookAt(0, 0.055, 0);
    this.yaw = camera.rotation.y;
    this.pitch = camera.rotation.x;
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.onBlur);
    canvas.addEventListener('pointerdown', this.onPointerDown);
    canvas.addEventListener('pointermove', this.onPointerMove);
    canvas.addEventListener('pointerup', this.onPointerUp);
    canvas.addEventListener('pointercancel', this.onPointerUp);
    canvas.addEventListener('contextmenu', this.preventContextMenu);
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) this.looking = false;
  }

  update(deltaSeconds: number): void {
    if (!this.enabled) return;
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
    this.canvas.removeEventListener('pointerdown', this.onPointerDown);
    this.canvas.removeEventListener('pointermove', this.onPointerMove);
    this.canvas.removeEventListener('pointerup', this.onPointerUp);
    this.canvas.removeEventListener('pointercancel', this.onPointerUp);
    this.canvas.removeEventListener('contextmenu', this.preventContextMenu);
  }

  private readonly onKeyDown = (event: KeyboardEvent): void => { this.keys.add(event.code); };
  private readonly onKeyUp = (event: KeyboardEvent): void => { this.keys.delete(event.code); };
  private readonly onBlur = (): void => { this.keys.clear(); this.looking = false; };
  private readonly preventContextMenu = (event: MouseEvent): void => { event.preventDefault(); };
  private readonly onPointerDown = (event: PointerEvent): void => {
    if (event.button !== 2 || !this.enabled) return;
    this.looking = true;
    this.canvas.setPointerCapture(event.pointerId);
  };
  private readonly onPointerUp = (event: PointerEvent): void => {
    if (event.button !== 2) return;
    this.looking = false;
    if (this.canvas.hasPointerCapture(event.pointerId)) this.canvas.releasePointerCapture(event.pointerId);
  };
  private readonly onPointerMove = (event: PointerEvent): void => {
    if (!this.looking || !this.enabled) return;
    this.yaw -= event.movementX * 0.0025;
    this.pitch = THREE.MathUtils.clamp(this.pitch - event.movementY * 0.0025, -1.45, 1.45);
    this.applyRotation();
  };
  private applyRotation(): void {
    this.camera.rotation.set(this.pitch, this.yaw, 0, 'YXZ');
  }
}
