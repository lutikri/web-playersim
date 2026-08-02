import * as THREE from 'three';
import type { Store } from '../app/Store';
import type { CameraRuntime } from '../scene/CameraRuntime';
import type { SceneBindings, SceneRuntime } from '../scene/SceneRuntime';

export type Action = 'disc' | 'power' | 'volume-up' | 'volume-down' | 'lid';
type ClickAction = Exclude<Action, 'disc'>;

export function shouldCommitClick(pressed: ClickAction | null, released: Action | null): boolean {
  return pressed !== null && pressed === released;
}

interface DragState {
  pointerId: number;
  plane: THREE.Plane;
  offset: THREE.Vector3;
  originPosition: THREE.Vector3;
  originQuaternion: THREE.Quaternion;
}

export class InteractionRuntime {
  private readonly raycaster = new THREE.Raycaster();
  private readonly pointer = new THREE.Vector2();
  private readonly targetByObject = new Map<THREE.Object3D, Action>();
  private readonly targets: THREE.Object3D[] = [];
  private readonly snapMarker: THREE.Mesh;
  private drag: DragState | null = null;
  private pendingClick: { action: ClickAction; pointerId: number } | null = null;
  private hovered: Action | null = null;

  constructor(
    private readonly camera: THREE.Camera,
    private readonly canvas: HTMLCanvasElement,
    private readonly bindings: SceneBindings,
    private readonly store: Store,
    private readonly cameraRuntime: CameraRuntime,
    private readonly sceneRuntime: SceneRuntime,
  ) {
    this.register(bindings.disc, 'disc');
    this.register(bindings.powerButton, 'power');
    this.register(bindings.volumeUpButton, 'volume-up');
    this.register(bindings.volumeDownButton, 'volume-down');
    this.register(bindings.lidInteraction, 'lid');
    this.snapMarker = new THREE.Mesh(
      new THREE.TorusGeometry(0.065, 0.003, 12, 48),
      new THREE.MeshBasicMaterial({ color: 0x39baff, transparent: true, opacity: 0.9, depthTest: false }),
    );
    this.snapMarker.rotation.x = Math.PI / 2;
    this.snapMarker.visible = false;
    bindings.discSocket.getWorldPosition(this.snapMarker.position);
    bindings.player.parent?.add(this.snapMarker);
    canvas.addEventListener('pointerdown', this.onPointerDown);
    canvas.addEventListener('pointermove', this.onPointerMove);
    canvas.addEventListener('pointerup', this.onPointerUp);
    canvas.addEventListener('pointercancel', this.cancelInteraction);
    window.addEventListener('blur', this.cancelInteraction);
  }

  dispose(): void {
    this.canvas.removeEventListener('pointerdown', this.onPointerDown);
    this.canvas.removeEventListener('pointermove', this.onPointerMove);
    this.canvas.removeEventListener('pointerup', this.onPointerUp);
    this.canvas.removeEventListener('pointercancel', this.cancelInteraction);
    window.removeEventListener('blur', this.cancelInteraction);
    this.snapMarker.geometry.dispose();
    (this.snapMarker.material as THREE.Material).dispose();
    this.snapMarker.removeFromParent();
  }

  private register(root: THREE.Object3D, action: Action): void {
    this.targets.push(root);
    root.traverse((object) => this.targetByObject.set(object, action));
  }

  private setPointer(event: PointerEvent): void {
    const bounds = this.canvas.getBoundingClientRect();
    this.pointer.set(
      ((event.clientX - bounds.left) / bounds.width) * 2 - 1,
      -((event.clientY - bounds.top) / bounds.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(this.pointer, this.camera);
  }

  private pick(): Action | null {
    const hit = this.raycaster.intersectObjects(this.targets, true)[0];
    if (!hit) return null;
    let object: THREE.Object3D | null = hit.object;
    while (object) {
      const action = this.targetByObject.get(object);
      if (action) return action;
      object = object.parent;
    }
    return null;
  }

  private readonly onPointerDown = (event: PointerEvent): void => {
    if (event.button !== 0) return;
    this.setPointer(event);
    const action = this.pick();
    if (action === 'disc') {
      this.beginDrag(event);
      return;
    }
    if (action) {
      this.pendingClick = { action, pointerId: event.pointerId };
      this.canvas.setPointerCapture(event.pointerId);
      this.canvas.style.cursor = 'pointer';
    }
  };

  private commitClick(action: ClickAction): void {
    if (action === 'power') {
      this.sceneRuntime.pulseButton(this.bindings.powerButton);
      this.store.dispatch({ type: 'POWER_PRESSED' });
    } else if (action === 'volume-up') {
      this.sceneRuntime.pulseButton(this.bindings.volumeUpButton);
      this.store.dispatch({ type: 'VOLUME_CHANGED', deltaDb: 2 });
    } else if (action === 'volume-down') {
      this.sceneRuntime.pulseButton(this.bindings.volumeDownButton);
      this.store.dispatch({ type: 'VOLUME_CHANGED', deltaDb: -2 });
    } else if (action === 'lid') {
      this.store.dispatch({ type: 'TRAY_TOGGLE_REQUESTED' });
    }
  }

  private beginDrag(event: PointerEvent): void {
    if (this.store.getState().discLocation !== 'table') return;
    const originPosition = this.bindings.disc.position.clone();
    const originQuaternion = this.bindings.disc.quaternion.clone();
    const worldPosition = this.bindings.disc.getWorldPosition(new THREE.Vector3());
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -worldPosition.y);
    const hit = this.raycaster.ray.intersectPlane(plane, new THREE.Vector3());
    if (!hit) return;
    this.drag = {
      pointerId: event.pointerId,
      plane,
      offset: worldPosition.sub(hit),
      originPosition,
      originQuaternion,
    };
    this.canvas.setPointerCapture(event.pointerId);
    this.cameraRuntime.setEnabled(false);
    this.store.dispatch({ type: 'DISC_DRAG_STARTED' });
  }

  private readonly onPointerMove = (event: PointerEvent): void => {
    this.setPointer(event);
    if (!this.drag) {
      const hovered = this.pick();
      if (hovered !== this.hovered) {
        this.hovered = hovered;
        this.canvas.style.cursor = hovered === 'disc' ? 'grab' : hovered ? 'pointer' : 'default';
      }
      return;
    }
    const hit = this.raycaster.ray.intersectPlane(this.drag.plane, new THREE.Vector3());
    if (!hit) return;
    const worldPosition = hit.add(this.drag.offset);
    const parent = this.bindings.disc.parent;
    this.bindings.disc.position.copy(parent ? parent.worldToLocal(worldPosition.clone()) : worldPosition);
    const socketPosition = this.bindings.discSocket.getWorldPosition(new THREE.Vector3());
    const inSnapRange = this.store.getState().transport === 'open'
      && worldPosition.distanceTo(socketPosition) < 0.115;
    this.snapMarker.visible = inSnapRange;
    this.store.dispatch({ type: 'DISC_SNAP_PREVIEW', active: inSnapRange });
    this.canvas.style.cursor = 'grabbing';
  };

  private readonly onPointerUp = (event: PointerEvent): void => {
    if (!this.drag) {
      if (!this.pendingClick || event.pointerId !== this.pendingClick.pointerId) return;
      this.setPointer(event);
      const releasedAction = this.pick();
      if (shouldCommitClick(this.pendingClick.action, releasedAction)) this.commitClick(this.pendingClick.action);
      this.finishPendingClick(event.pointerId);
      return;
    }
    if (event.pointerId !== this.drag.pointerId) return;
    const shouldSnap = this.store.getState().snapPreview;
    if (shouldSnap) {
      const socketPosition = this.bindings.discSocket.getWorldPosition(new THREE.Vector3());
      const parent = this.bindings.disc.parent;
      this.bindings.disc.position.copy(parent ? parent.worldToLocal(socketPosition.clone()) : socketPosition);
      this.bindings.disc.quaternion.copy(this.bindings.discSocket.getWorldQuaternion(new THREE.Quaternion()));
      this.store.dispatch({ type: 'DISC_DROPPED', target: 'player' });
    } else {
      this.returnToOrigin();
      this.store.dispatch({ type: 'DISC_DROPPED', target: 'origin' });
    }
    this.finishDrag(event.pointerId);
  };

  private readonly cancelInteraction = (): void => {
    if (this.drag) {
      const pointerId = this.drag.pointerId;
      this.returnToOrigin();
      this.store.dispatch({ type: 'DISC_DROPPED', target: 'origin' });
      this.finishDrag(pointerId);
    }
    if (this.pendingClick) this.finishPendingClick(this.pendingClick.pointerId);
  };

  private finishPendingClick(pointerId: number): void {
    if (this.canvas.hasPointerCapture(pointerId)) this.canvas.releasePointerCapture(pointerId);
    this.pendingClick = null;
    this.canvas.style.cursor = 'default';
  }

  private returnToOrigin(): void {
    if (!this.drag) return;
    this.bindings.disc.position.copy(this.drag.originPosition);
    this.bindings.disc.quaternion.copy(this.drag.originQuaternion);
  }

  private finishDrag(pointerId: number): void {
    if (this.canvas.hasPointerCapture(pointerId)) this.canvas.releasePointerCapture(pointerId);
    this.drag = null;
    this.snapMarker.visible = false;
    this.canvas.style.cursor = 'default';
    this.cameraRuntime.setEnabled(true);
  }
}
