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
  anchorBody: RigidBody;
  joint: ImpulseJoint;
  priorAngularDamping: number;
  priorLinearDamping: number;
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
  private readonly initialPosition: THREE.Vector3;
  private readonly initialQuaternion: THREE.Quaternion;

  private constructor(
    private readonly rapier: RapierModule,
    private readonly world: World,
    private readonly disc: THREE.Object3D,
    private readonly discBody: RigidBody,
  ) {
    const initial = worldTransform(disc);
    this.initialPosition = initial.position;
    this.initialQuaternion = initial.quaternion;
  }

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
      if (object === bindings.discCollider || !(object instanceof THREE.Mesh)) return;
      createStaticBox(object);
    });
    const discTransform = worldTransform(bindings.disc);
    const discBody = world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(discTransform.position.x, discTransform.position.y, discTransform.position.z)
        .setRotation(discTransform.quaternion)
        .setLinearDamping(0.65)
        .setAngularDamping(0.8)
        .setCcdEnabled(true)
        .setCanSleep(true),
    );
    const collider = bindings.discCollider;
    if (!(collider instanceof THREE.Mesh)) throw new Error('Disc collider UCX_SM_Disk1_01 must be a Mesh.');
    collider.geometry.computeBoundingBox();
    const colliderBox = collider.geometry.boundingBox;
    if (!colliderBox) throw new Error('Disc collider UCX_SM_Disk1_01 has no bounding box.');
    collider.updateWorldMatrix(true, false);
    bindings.disc.updateWorldMatrix(true, false);
    const colliderInDisc = bindings.disc.matrixWorld.clone().invert().multiply(collider.matrixWorld);
    const relativePosition = new THREE.Vector3();
    const relativeQuaternion = new THREE.Quaternion();
    const relativeScale = new THREE.Vector3();
    colliderInDisc.decompose(relativePosition, relativeQuaternion, relativeScale);
    const colliderSize = colliderBox.getSize(new THREE.Vector3()).multiply(relativeScale);
    const colliderCenter = colliderBox.getCenter(new THREE.Vector3()).applyMatrix4(colliderInDisc);
    world.createCollider(
      RAPIER.ColliderDesc.cylinder(
        Math.max(Math.abs(colliderSize.y) * 0.5, 0.001),
        Math.max(Math.abs(colliderSize.x), Math.abs(colliderSize.z)) * 0.5,
      )
        .setTranslation(colliderCenter.x, colliderCenter.y, colliderCenter.z)
        .setRotation(relativeQuaternion)
        .setDensity(400)
        .setFriction(0.42)
        .setRestitution(0.04),
      discBody,
    );
    return new PhysicsRuntime(RAPIER, world, bindings.disc, discBody);
  }

  update(deltaSeconds: number): void {
    this.accumulator += Math.min(deltaSeconds, 0.05);
    while (this.accumulator >= FIXED_TIMESTEP) {
      this.world.timestep = FIXED_TIMESTEP;
      this.world.step();
      this.accumulator -= FIXED_TIMESTEP;
    }
    this.syncDiscObject();
  }

  beginDiscGrab(worldPoint: THREE.Vector3): void {
    this.endDiscGrab();
    this.discBody.setBodyType(this.rapier.RigidBodyType.Dynamic, true);
    this.discBody.setEnabled(true);
    this.discBody.enableCcd(true);
    const bodyPosition = this.discBody.translation();
    const bodyRotation = this.discBody.rotation();
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
    const mass = Math.max(0.01, this.discBody.mass());
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
      this.discBody,
      true,
    );
    this.grabConstraint = {
      anchorBody,
      joint,
      priorAngularDamping: this.discBody.angularDamping(),
      priorLinearDamping: this.discBody.linearDamping(),
    };
    this.discBody.setLinearDamping(1.6);
    this.discBody.setAngularDamping(1.15);
    this.discBody.wakeUp();
  }

  driveDiscGrab(target: THREE.Vector3, deltaSeconds: number): void {
    if (!this.grabConstraint) return;
    const currentValue = this.grabConstraint.anchorBody.translation();
    const current = new THREE.Vector3(currentValue.x, currentValue.y, currentValue.z);
    const next = limitGrabAnchorMovement(current, target, deltaSeconds);
    this.grabConstraint.anchorBody.setNextKinematicTranslation(next);
    this.discBody.wakeUp();
  }

  endDiscGrab(): void {
    const constraint = this.grabConstraint;
    if (!constraint) return;
    this.discBody.setLinearDamping(constraint.priorLinearDamping);
    this.discBody.setAngularDamping(constraint.priorAngularDamping);
    if (constraint.joint.isValid()) this.world.removeImpulseJoint(constraint.joint, true);
    this.world.removeRigidBody(constraint.anchorBody);
    this.grabConstraint = null;
    this.discBody.wakeUp();
  }

  snapDisc(worldPosition: THREE.Vector3, worldQuaternion: THREE.Quaternion): void {
    this.endDiscGrab();
    this.discBody.setBodyType(this.rapier.RigidBodyType.KinematicPositionBased, true);
    this.discBody.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.discBody.setAngvel({ x: 0, y: 0, z: 0 }, true);
    this.discBody.setTranslation(worldPosition, true);
    this.discBody.setRotation(worldQuaternion, true);
    this.syncDiscObject();
  }

  resetDisc(): void {
    this.endDiscGrab();
    this.discBody.setBodyType(this.rapier.RigidBodyType.Dynamic, true);
    this.discBody.setTranslation(this.initialPosition, true);
    this.discBody.setRotation(this.initialQuaternion, true);
    this.discBody.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.discBody.setAngvel({ x: 0, y: 0, z: 0 }, true);
    this.syncDiscObject();
  }

  getDiscWorldPosition(target = new THREE.Vector3()): THREE.Vector3 {
    const translation = this.discBody.translation();
    return target.set(translation.x, translation.y, translation.z);
  }

  needsShadowUpdate(): boolean {
    return this.grabConstraint !== null || (this.discBody.isDynamic() && !this.discBody.isSleeping());
  }

  dispose(): void {
    this.endDiscGrab();
    this.world.free();
  }

  private syncDiscObject(): void {
    const translation = this.discBody.translation();
    const rotation = this.discBody.rotation();
    const worldMatrix = new THREE.Matrix4().compose(
      new THREE.Vector3(translation.x, translation.y, translation.z),
      new THREE.Quaternion(rotation.x, rotation.y, rotation.z, rotation.w),
      new THREE.Vector3(1, 1, 1),
    );
    if (this.disc.parent) {
      this.disc.parent.updateWorldMatrix(true, false);
      worldMatrix.premultiply(this.disc.parent.matrixWorld.clone().invert());
    }
    const scale = new THREE.Vector3();
    worldMatrix.decompose(this.disc.position, this.disc.quaternion, scale);
  }
}
