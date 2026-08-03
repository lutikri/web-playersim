import type {
  ImpulseJoint,
  RigidBody,
  World,
} from '@dimforge/rapier3d-compat';
import type RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import type { SceneBindings } from '../scene/SceneRuntime';

type RapierModule = typeof RAPIER;

interface GrabConstraint {
  discId: number;
  anchorBody: RigidBody;
  joint: ImpulseJoint;
  priorAngularDamping: number;
  priorLinearDamping: number;
}

interface DiscPhysicsState {
  root: THREE.Object3D;
  body: RigidBody;
  initialPosition: THREE.Vector3;
  initialQuaternion: THREE.Quaternion;
}

const FIXED_TIMESTEP = 1 / 60;
const MAX_GRAB_ANCHOR_SPEED = 3.5;

function worldTransform(object: THREE.Object3D): {
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
  scale: THREE.Vector3;
} {
  object.updateWorldMatrix(true, false);
  const position = new THREE.Vector3();
  const quaternion = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  object.matrixWorld.decompose(position, quaternion, scale);
  return { position, quaternion, scale };
}

export function limitGrabAnchorMovement(
  current: THREE.Vector3,
  target: THREE.Vector3,
  deltaSeconds: number,
  maxSpeed = MAX_GRAB_ANCHOR_SPEED,
): THREE.Vector3 {
  const movement = target.clone().sub(current);
  const maxDistance = Math.max(0, deltaSeconds) * maxSpeed;
  if (movement.lengthSq() > maxDistance * maxDistance) movement.setLength(maxDistance);
  return current.clone().add(movement);
}

export function hasColliderForRoot(colliders: THREE.Object3D[], root: THREE.Object3D): boolean {
  return colliders.some((collider) => {
    let ancestor: THREE.Object3D | null = collider;
    while (ancestor) {
      if (ancestor === root) return true;
      ancestor = ancestor.parent;
    }
    return false;
  });
}

export class PhysicsRuntime {
  private accumulator = 0;
  private grabConstraint: GrabConstraint | null = null;
  private readonly discs = new Map<number, DiscPhysicsState>();

  private constructor(
    private readonly rapier: RapierModule,
    private readonly world: World,
  ) {}

  static async create(bindings: SceneBindings): Promise<PhysicsRuntime> {
    const { default: RAPIER } = await import('@dimforge/rapier3d-compat');
    await RAPIER.init();
    const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });

    const createStaticBox = (object: THREE.Object3D): void => {
      if (!(object instanceof THREE.Mesh)) return;
      object.geometry.computeBoundingBox();
      const box = object.geometry.boundingBox;
      if (!box) return;
      const transform = worldTransform(object);
      const center = box.getCenter(new THREE.Vector3()).multiply(transform.scale).applyQuaternion(transform.quaternion)
        .add(transform.position);
      const halfExtents = box.getSize(new THREE.Vector3()).multiply(transform.scale).multiplyScalar(0.5);
      const body = world.createRigidBody(
        RAPIER.RigidBodyDesc.fixed()
          .setTranslation(center.x, center.y, center.z)
          .setRotation(transform.quaternion),
      );
      world.createCollider(
        RAPIER.ColliderDesc.cuboid(
          Math.max(Math.abs(halfExtents.x), 0.002),
          Math.max(Math.abs(halfExtents.y), 0.002),
          Math.max(Math.abs(halfExtents.z), 0.002),
        ).setFriction(0.72),
        body,
      );
    };

    bindings.colliders.forEach((object) => {
      if (!(object instanceof THREE.Mesh)) return;
      createStaticBox(object);
    });
    return new PhysicsRuntime(RAPIER, world);
  }

  registerDisc(id: number, root: THREE.Object3D, collider: THREE.Object3D): void {
    if (this.discs.has(id)) throw new Error(`Disc physics id ${id} is already registered.`);
    const discTransform = worldTransform(root);
    const body = this.world.createRigidBody(
      this.rapier.RigidBodyDesc.dynamic()
        .setTranslation(discTransform.position.x, discTransform.position.y, discTransform.position.z)
        .setRotation(discTransform.quaternion)
        .setLinearDamping(0.65)
        .setAngularDamping(0.8)
        .setCcdEnabled(true)
        .setCanSleep(true),
    );
    if (!(collider instanceof THREE.Mesh)) throw new Error('Disc collider UCX_SM_Disk1_01 must be a Mesh.');
    collider.geometry.computeBoundingBox();
    const colliderBox = collider.geometry.boundingBox;
    if (!colliderBox) throw new Error('Disc collider UCX_SM_Disk1_01 has no bounding box.');
    collider.updateWorldMatrix(true, false);
    root.updateWorldMatrix(true, false);
    const colliderInDisc = root.matrixWorld.clone().invert().multiply(collider.matrixWorld);
    const relativePosition = new THREE.Vector3();
    const relativeQuaternion = new THREE.Quaternion();
    const relativeScale = new THREE.Vector3();
    colliderInDisc.decompose(relativePosition, relativeQuaternion, relativeScale);
    const colliderSize = colliderBox.getSize(new THREE.Vector3()).multiply(relativeScale);
    const colliderCenter = colliderBox.getCenter(new THREE.Vector3()).applyMatrix4(colliderInDisc);
    this.world.createCollider(
      this.rapier.ColliderDesc.cylinder(
        Math.max(Math.abs(colliderSize.y) * 0.5, 0.001),
        Math.max(Math.abs(colliderSize.x), Math.abs(colliderSize.z)) * 0.5,
      )
        .setTranslation(colliderCenter.x, colliderCenter.y, colliderCenter.z)
        .setRotation(relativeQuaternion)
        .setDensity(400)
        .setFriction(0.42)
        .setRestitution(0.04),
      body,
    );
    this.discs.set(id, {
      root,
      body,
      initialPosition: discTransform.position,
      initialQuaternion: discTransform.quaternion,
    });
  }

  update(deltaSeconds: number): void {
    this.accumulator += Math.min(deltaSeconds, 0.05);
    while (this.accumulator >= FIXED_TIMESTEP) {
      this.world.timestep = FIXED_TIMESTEP;
      this.world.step();
      this.accumulator -= FIXED_TIMESTEP;
    }
    this.discs.forEach((disc) => this.syncDiscObject(disc));
  }

  beginDiscGrab(discId: number, worldPoint: THREE.Vector3): void {
    this.endDiscGrab();
    const disc = this.requireDisc(discId);
    disc.body.setBodyType(this.rapier.RigidBodyType.Dynamic, true);
    disc.body.setEnabled(true);
    disc.body.enableCcd(true);
    const bodyPosition = disc.body.translation();
    const bodyRotation = disc.body.rotation();
    const inverseRotation = new THREE.Quaternion(
      bodyRotation.x,
      bodyRotation.y,
      bodyRotation.z,
      bodyRotation.w,
    ).invert();
    const localGrabPoint = worldPoint.clone()
      .sub(new THREE.Vector3(bodyPosition.x, bodyPosition.y, bodyPosition.z))
      .applyQuaternion(inverseRotation);
    const anchorBody = this.world.createRigidBody(
      this.rapier.RigidBodyDesc.kinematicPositionBased()
        .setTranslation(worldPoint.x, worldPoint.y, worldPoint.z),
    );
    const mass = Math.max(0.01, disc.body.mass());
    const naturalFrequency = 22;
    const stiffness = mass * naturalFrequency * naturalFrequency;
    const damping = 2 * 0.82 * mass * naturalFrequency;
    const joint = this.world.createImpulseJoint(
      this.rapier.JointData.spring(
        0.018,
        stiffness,
        damping,
        { x: 0, y: 0, z: 0 },
        localGrabPoint,
      ),
      anchorBody,
      disc.body,
      true,
    );
    this.grabConstraint = {
      discId,
      anchorBody,
      joint,
      priorAngularDamping: disc.body.angularDamping(),
      priorLinearDamping: disc.body.linearDamping(),
    };
    disc.body.setLinearDamping(1.6);
    disc.body.setAngularDamping(1.15);
    disc.body.wakeUp();
  }

  driveDiscGrab(target: THREE.Vector3, deltaSeconds: number): void {
    if (!this.grabConstraint) return;
    const currentValue = this.grabConstraint.anchorBody.translation();
    const current = new THREE.Vector3(currentValue.x, currentValue.y, currentValue.z);
    const next = limitGrabAnchorMovement(current, target, deltaSeconds);
    this.grabConstraint.anchorBody.setNextKinematicTranslation(next);
    this.requireDisc(this.grabConstraint.discId).body.wakeUp();
  }

  endDiscGrab(): void {
    const constraint = this.grabConstraint;
    if (!constraint) return;
    const disc = this.requireDisc(constraint.discId);
    disc.body.setLinearDamping(constraint.priorLinearDamping);
    disc.body.setAngularDamping(constraint.priorAngularDamping);
    if (constraint.joint.isValid()) this.world.removeImpulseJoint(constraint.joint, true);
    this.world.removeRigidBody(constraint.anchorBody);
    this.grabConstraint = null;
    disc.body.wakeUp();
  }

  snapDisc(discId: number, worldPosition: THREE.Vector3, worldQuaternion: THREE.Quaternion): void {
    this.endDiscGrab();
    const disc = this.requireDisc(discId);
    disc.body.setBodyType(this.rapier.RigidBodyType.KinematicPositionBased, true);
    disc.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    disc.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    disc.body.setTranslation(worldPosition, true);
    disc.body.setRotation(worldQuaternion, true);
    this.syncDiscObject(disc);
  }

  resetDisc(discId: number): void {
    this.endDiscGrab();
    const disc = this.requireDisc(discId);
    disc.body.setBodyType(this.rapier.RigidBodyType.Dynamic, true);
    disc.body.setTranslation(disc.initialPosition, true);
    disc.body.setRotation(disc.initialQuaternion, true);
    disc.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    disc.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    this.syncDiscObject(disc);
  }

  getDiscWorldPosition(discId: number, target = new THREE.Vector3()): THREE.Vector3 {
    const translation = this.requireDisc(discId).body.translation();
    return target.set(translation.x, translation.y, translation.z);
  }

  needsShadowUpdate(): boolean {
    if (this.grabConstraint !== null) return true;
    return [...this.discs.values()].some((disc) => disc.body.isDynamic() && !disc.body.isSleeping());
  }

  dispose(): void {
    this.endDiscGrab();
    this.world.free();
  }

  private requireDisc(id: number): DiscPhysicsState {
    const disc = this.discs.get(id);
    if (!disc) throw new Error(`Unknown disc physics id ${id}.`);
    return disc;
  }

  private syncDiscObject(disc: DiscPhysicsState): void {
    const translation = disc.body.translation();
    const rotation = disc.body.rotation();
    const worldMatrix = new THREE.Matrix4().compose(
      new THREE.Vector3(translation.x, translation.y, translation.z),
      new THREE.Quaternion(rotation.x, rotation.y, rotation.z, rotation.w),
      new THREE.Vector3(1, 1, 1),
    );
    if (disc.root.parent) {
      disc.root.parent.updateWorldMatrix(true, false);
      worldMatrix.premultiply(disc.root.parent.matrixWorld.clone().invert());
    }
    const scale = new THREE.Vector3();
    worldMatrix.decompose(disc.root.position, disc.root.quaternion, scale);
  }
}
