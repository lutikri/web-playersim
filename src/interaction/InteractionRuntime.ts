import * as THREE from 'three';
import type { DiscLocation, Store, TransportState } from '../app/Store';
import type { PhysicsRuntime } from '../physics/PhysicsRuntime';
import type { CameraRuntime } from '../scene/CameraRuntime';
import type { SceneBindings, SceneRuntime } from '../scene/SceneRuntime';

export type Action = 'disc' | 'power' | 'volume-up' | 'volume-down' | 'source-select' | 'play-pause'
  | 'track-next' | 'track-previous' | 'stop' | 'lid';
type ClickAction = Exclude<Action, 'disc'>;

export function shouldCommitClick(pressed: ClickAction | null, released: Action | null): boolean {
  return pressed !== null && pressed === released;
}

export function isDiscPickable(location: DiscLocation, transport: TransportState): boolean {
  return location === 'table' || (location === 'player' && transport === 'open');
}

interface DragState {
  discId: number;
  minimumWorldY: number | null;
  pointerId: number;
  plane: THREE.Plane;
  offset: THREE.Vector3;
  socketAssistArmed: boolean;
  targetWorld: THREE.Vector3;
}

interface PickResult {
  action: Action;
  discId: number | null;
  point: THREE.Vector3;
}

interface PickDebugRow {
  mesh: string;
  path: string;
  distance: number;
  action: Action | '-';
  discId: number | '-';
  result: 'accepted' | 'skipped';
  reason: string;
}

const DISC_SNAP_DISTANCE = 0.115;
const DISC_REMOVAL_LIFT = 0.055;
const SOCKET_CURSOR_RADIUS = 0.24;

export function socketAttractionStrength(
  pointer: THREE.Vector2,
  socket: THREE.Vector2,
  radius = SOCKET_CURSOR_RADIUS,
): number {
  const normalizedDistance = pointer.distanceTo(socket) / Math.max(radius, 1e-6);
  const proximity = THREE.MathUtils.clamp(1 - normalizedDistance, 0, 1);
  return proximity * proximity * (3 - 2 * proximity);
}

export function isDiscInSnapRange(
  transportOpen: boolean,
  discPosition: THREE.Vector3,
  socketPosition: THREE.Vector3,
): boolean {
  return transportOpen && discPosition.distanceTo(socketPosition) < DISC_SNAP_DISTANCE;
}

export class InteractionRuntime {
  private readonly raycaster = new THREE.Raycaster();
  private readonly pointer = new THREE.Vector2();
  private readonly socketProjected = new THREE.Vector3();
  private readonly assistedTarget = new THREE.Vector3();
  private readonly targetByObject = new Map<THREE.Object3D, { action: Action; discId: number | null }>();
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
    private readonly physicsRuntime: PhysicsRuntime,
  ) {
    this.register(bindings.powerButton, 'power');
    this.register(bindings.volumeUpButton, 'volume-up');
    this.register(bindings.volumeDownButton, 'volume-down');
    this.register(bindings.sourceSelectButton, 'source-select');
    this.register(bindings.playPauseButton, 'play-pause');
    this.register(bindings.nextButton, 'track-next');
    this.register(bindings.previousButton, 'track-previous');
    this.register(bindings.stopButton, 'stop');
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

  registerDisc(id: number, root: THREE.Object3D): void {
    this.register(root, 'disc', id);
  }

  update(deltaSeconds: number): void {
    if (!this.drag) return;
    const attraction = this.getSocketAttraction();
    this.assistedTarget.copy(this.drag.targetWorld);
    if (attraction > 0) {
      const socketPosition = this.bindings.discSocket.getWorldPosition(new THREE.Vector3());
      socketPosition.y += 0.035;
      this.assistedTarget.lerp(socketPosition, attraction * 0.9);
    }
    this.physicsRuntime.driveDiscGrab(this.assistedTarget, deltaSeconds);
    this.updateSnapPreview(attraction);
  }

  private register(root: THREE.Object3D, action: Action, discId: number | null = null): void {
    this.targets.push(root);
    root.traverse((object) => this.targetByObject.set(object, { action, discId }));
  }

  private setPointer(event: PointerEvent): void {
    const bounds = this.canvas.getBoundingClientRect();
    this.pointer.set(
      ((event.clientX - bounds.left) / bounds.width) * 2 - 1,
      -((event.clientY - bounds.top) / bounds.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(this.pointer, this.camera);
  }

  private pick(debugEvent?: PointerEvent): PickResult | null {
    const state = this.store.getState();
    const hits = this.raycaster.intersectObjects(this.targets, true);
    const debugRows: PickDebugRow[] = [];
    let result: PickResult | null = null;
    for (const hit of hits) {
      let object: THREE.Object3D | null = hit.object;
      let target: { action: Action; discId: number | null } | undefined;
      while (object) {
        target = this.targetByObject.get(object);
        if (target) break;
        object = object.parent;
      }
      if (!target) {
        debugRows.push(this.debugRow(hit, null, 'skipped', 'no registered action'));
        continue;
      }
      if (target.action === 'disc' && target.discId !== null) {
        const disc = state.discs.find((item) => item.id === target.discId);
        if (!disc || !isDiscPickable(disc.location, state.transport)) {
          debugRows.push(this.debugRow(
            hit,
            target,
            'skipped',
            disc ? `disc is ${disc.location}; lid is ${state.transport}` : 'disc is missing from store',
          ));
          continue;
        }
      }
      result = { ...target, point: hit.point.clone() };
      debugRows.push(this.debugRow(hit, target, 'accepted', 'first usable hit'));
      break;
    }
    if (debugEvent) {
      console.groupCollapsed(
        `[Input debug] 3D pointerdown @ ${Math.round(debugEvent.clientX)}, ${Math.round(debugEvent.clientY)}`,
      );
      console.log('NDC', { x: this.pointer.x, y: this.pointer.y });
      console.log('Selected', result ? { action: result.action, discId: result.discId, point: result.point.toArray() } : null);
      console.table(debugRows);
      console.groupEnd();
    }
    return result;
  }

  private debugRow(
    hit: THREE.Intersection,
    target: { action: Action; discId: number | null } | null,
    result: 'accepted' | 'skipped',
    reason: string,
  ): PickDebugRow {
    const path: string[] = [];
    let object: THREE.Object3D | null = hit.object;
    while (object && path.length < 6) {
      path.push(object.name || object.type);
      object = object.parent;
    }
    return {
      mesh: hit.object.name || hit.object.type,
      path: path.join(' < '),
      distance: Number(hit.distance.toFixed(4)),
      action: target?.action ?? '-',
      discId: target?.discId ?? '-',
      result,
      reason,
    };
  }

  private readonly onPointerDown = (event: PointerEvent): void => {
    if (event.button !== 0) return;
    this.setPointer(event);
    const pick = this.pick(event);
    const action = pick?.action ?? null;
    if (action === 'disc') {
      if (pick?.discId !== null && pick?.discId !== undefined) {
        this.beginDrag(event, pick.discId, pick.point);
      }
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
      this.store.dispatch(this.store.getState().power === 'on'
        ? { type: 'VOLUME_CHANGED', delta: 1 }
        : { type: 'VOLUME_BUTTON_PRESSED' });
    } else if (action === 'volume-down') {
      this.sceneRuntime.pulseButton(this.bindings.volumeDownButton);
      this.store.dispatch(this.store.getState().power === 'on'
        ? { type: 'VOLUME_CHANGED', delta: -1 }
        : { type: 'VOLUME_BUTTON_PRESSED' });
    } else if (action === 'source-select') {
      this.store.dispatch({ type: 'SOURCE_SELECT_PRESSED' });
    } else if (action === 'play-pause') {
      this.store.dispatch({ type: 'PLAY_PAUSE_PRESSED' });
    } else if (action === 'track-next') {
      this.store.dispatch({ type: 'TRACK_NEXT_PRESSED' });
    } else if (action === 'track-previous') {
      this.store.dispatch({ type: 'TRACK_PREVIOUS_PRESSED' });
    } else if (action === 'stop') {
      this.store.dispatch({ type: 'STOP_PRESSED' });
    } else if (action === 'lid') {
      this.store.dispatch({ type: 'TRAY_TOGGLE_REQUESTED' });
    }
  }

  private beginDrag(event: PointerEvent, discId: number, grabPoint: THREE.Vector3): void {
    const state = this.store.getState();
    const disc = state.discs.find((item) => item.id === discId);
    if (!disc || !isDiscPickable(disc.location, state.transport)) return;
    const removingFromPlayer = disc.location === 'player';
    const socketPosition = removingFromPlayer
      ? this.bindings.discSocket.getWorldPosition(new THREE.Vector3())
      : null;
    const minimumWorldY = socketPosition ? socketPosition.y + DISC_REMOVAL_LIFT : null;
    const planeNormal = this.camera.getWorldDirection(new THREE.Vector3());
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(planeNormal, grabPoint);
    const hit = this.raycaster.ray.intersectPlane(plane, new THREE.Vector3());
    if (!hit) return;
    this.drag = {
      discId,
      minimumWorldY,
      pointerId: event.pointerId,
      plane,
      offset: grabPoint.clone().sub(hit),
      socketAssistArmed: !removingFromPlayer,
      targetWorld: grabPoint.clone(),
    };
    if (minimumWorldY !== null) this.drag.targetWorld.y = Math.max(this.drag.targetWorld.y, minimumWorldY);
    this.store.dispatch({ type: 'DISC_DRAG_STARTED', discId });
    if (this.store.getState().draggedDiscId !== discId) {
      this.drag = null;
      return;
    }
    this.physicsRuntime.beginDiscGrab(discId, grabPoint);
    this.canvas.setPointerCapture(event.pointerId);
    this.cameraRuntime.setEnabled(false);
  }

  private readonly onPointerMove = (event: PointerEvent): void => {
    this.setPointer(event);
    if (!this.drag) {
      const hovered = this.pick()?.action ?? null;
      if (hovered !== this.hovered) {
        this.hovered = hovered;
        this.canvas.style.cursor = hovered === 'disc' ? 'grab' : hovered ? 'pointer' : 'default';
      }
      return;
    }
    const hit = this.raycaster.ray.intersectPlane(this.drag.plane, new THREE.Vector3());
    if (!hit) return;
    this.drag.targetWorld.copy(hit.add(this.drag.offset));
    if (this.drag.minimumWorldY !== null) {
      this.drag.targetWorld.y = Math.max(this.drag.targetWorld.y, this.drag.minimumWorldY);
    }
    if (!this.drag.socketAssistArmed) {
      this.bindings.discSocket.getWorldPosition(this.socketProjected).project(this.camera);
      const distance = this.pointer.distanceTo(new THREE.Vector2(this.socketProjected.x, this.socketProjected.y));
      if (distance > SOCKET_CURSOR_RADIUS * 1.3) this.drag.socketAssistArmed = true;
    }
    this.canvas.style.cursor = 'grabbing';
  };

  private readonly onPointerUp = (event: PointerEvent): void => {
    if (!this.drag) {
      if (!this.pendingClick || event.pointerId !== this.pendingClick.pointerId) return;
      this.setPointer(event);
      const releasedAction = this.pick()?.action ?? null;
      if (shouldCommitClick(this.pendingClick.action, releasedAction)) this.commitClick(this.pendingClick.action);
      this.finishPendingClick(event.pointerId);
      return;
    }
    if (event.pointerId !== this.drag.pointerId) return;
    this.updateSnapPreview(this.getSocketAttraction());
    const shouldSnap = this.store.getState().snapPreview;
    if (shouldSnap) {
      const socketPosition = this.bindings.discSocket.getWorldPosition(new THREE.Vector3());
      const socketQuaternion = this.bindings.discSocket.getWorldQuaternion(new THREE.Quaternion());
      this.physicsRuntime.snapDisc(this.drag.discId, socketPosition, socketQuaternion);
      this.store.dispatch({ type: 'DISC_DROPPED', discId: this.drag.discId, target: 'player' });
    } else {
      this.physicsRuntime.endDiscGrab();
      this.store.dispatch({ type: 'DISC_DROPPED', discId: this.drag.discId, target: 'origin' });
    }
    this.finishDrag(event.pointerId);
  };

  private readonly cancelInteraction = (): void => {
    if (this.drag) {
      const pointerId = this.drag.pointerId;
      this.physicsRuntime.resetDisc(this.drag.discId);
      this.store.dispatch({ type: 'DISC_DROPPED', discId: this.drag.discId, target: 'origin' });
      this.finishDrag(pointerId);
    }
    if (this.pendingClick) this.finishPendingClick(this.pendingClick.pointerId);
  };

  private finishPendingClick(pointerId: number): void {
    if (this.canvas.hasPointerCapture(pointerId)) this.canvas.releasePointerCapture(pointerId);
    this.pendingClick = null;
    this.canvas.style.cursor = 'default';
  }

  private finishDrag(pointerId: number): void {
    if (this.canvas.hasPointerCapture(pointerId)) this.canvas.releasePointerCapture(pointerId);
    this.drag = null;
    this.snapMarker.visible = false;
    this.canvas.style.cursor = 'default';
    this.cameraRuntime.setEnabled(true);
  }

  private getSocketAttraction(): number {
    if (!this.drag?.socketAssistArmed) return 0;
    const state = this.store.getState();
    if (state.transport !== 'open' || state.insertedDiscId !== null) return 0;
    this.bindings.discSocket.getWorldPosition(this.socketProjected).project(this.camera);
    if (this.socketProjected.z < -1 || this.socketProjected.z > 1) return 0;
    return socketAttractionStrength(
      this.pointer,
      new THREE.Vector2(this.socketProjected.x, this.socketProjected.y),
    );
  }

  private updateSnapPreview(attraction = 0): void {
    if (!this.drag) return;
    const discPosition = this.physicsRuntime.getDiscWorldPosition(this.drag.discId);
    const socketPosition = this.bindings.discSocket.getWorldPosition(new THREE.Vector3());
    const inSnapRange = attraction > 0.18 || isDiscInSnapRange(
      this.store.getState().transport === 'open' && this.store.getState().insertedDiscId === null,
      discPosition,
      socketPosition,
    );
    this.snapMarker.visible = inSnapRange;
    this.store.dispatch({ type: 'DISC_SNAP_PREVIEW', active: inSnapRange });
  }
}
