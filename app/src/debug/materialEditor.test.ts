import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { collectSceneMaterials, serializeMaterial } from './materialEditor';

describe('material editor helpers', () => {
  it('collects shared materials once and serializes physical glass settings', () => {
    const root = new THREE.Group();
    const glass = new THREE.MeshPhysicalMaterial({
      name: 'Glass',
      opacity: 0.45,
      transparent: true,
      transmission: 0.7,
      roughness: 0.2,
      ior: 1.45,
      thickness: 0.08,
    });
    root.add(
      new THREE.Mesh(new THREE.BoxGeometry(), glass),
      new THREE.Mesh(new THREE.BoxGeometry(), [glass, new THREE.MeshStandardMaterial({ name: 'Body' })]),
    );

    const materials = collectSceneMaterials(root);
    const serialized = serializeMaterial(glass);

    expect(materials).toHaveLength(2);
    expect(serialized.name).toBe('Glass');
    expect(serialized.properties).toMatchObject({
      opacity: 0.45,
      transparent: true,
      transmission: 0.7,
      roughness: 0.2,
      ior: 1.45,
      thickness: 0.08,
    });
  });
});
