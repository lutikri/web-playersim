import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { clampHotspotToEdge } from './CameraNavigationRuntime';

describe('camera hotspot placement', () => {
  it('keeps visible points at their projected position', () => {
    const placement = clampHotspotToEdge(new THREE.Vector3(0.4, -0.25, 0.5), false);
    expect(placement.offscreen).toBe(false);
    expect(placement.position.toArray()).toEqual([0.4, -0.25]);
  });

  it('pins offscreen and behind-camera points to the safe edge', () => {
    const offscreen = clampHotspotToEdge(new THREE.Vector3(2, 0.25, 0.5), false);
    expect(offscreen.offscreen).toBe(true);
    expect(offscreen.position.x).toBeCloseTo(0.94);

    const behind = clampHotspotToEdge(new THREE.Vector3(0.5, 0.25, 2), true);
    expect(behind.offscreen).toBe(true);
    expect(behind.position.x).toBeLessThan(0);
  });
});
