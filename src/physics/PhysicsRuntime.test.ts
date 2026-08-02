import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { hasColliderForRoot, limitGrabAnchorMovement } from './PhysicsRuntime';

describe('physical grab anchor', () => {
  it('limits cursor jumps before driving the spring joint', () => {
    const result = limitGrabAnchorMovement(
      new THREE.Vector3(0, 0, 0),
      new THREE.Vector3(10, 0, 0),
      0.1,
      2,
    );
    expect(result.x).toBeCloseTo(0.2);
    expect(result.y).toBe(0);
  });
});

describe('static collider ownership', () => {
  it('recognizes authored colliders anywhere below the prefab root', () => {
    const player = new THREE.Group();
    const nested = new THREE.Group();
    const collider = new THREE.Mesh();
    player.add(nested);
    nested.add(collider);
    expect(hasColliderForRoot([collider], player)).toBe(true);
    expect(hasColliderForRoot([collider], new THREE.Group())).toBe(false);
  });
});
