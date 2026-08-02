import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { applyLevelConfig, type LevelConfig } from './LevelConfigRuntime';

describe('level config runtime', () => {
  it('applies object, light, environment and physical material settings', () => {
    const scene = new THREE.Scene();
    const player = new THREE.Group();
    player.name = 'Player';
    const light = new THREE.PointLight();
    light.name = 'Fill Point';
    const glass = new THREE.MeshPhysicalMaterial({ name: 'Glass' });
    player.add(new THREE.Mesh(new THREE.BoxGeometry(), glass));
    scene.add(player, light);
    const renderer = { toneMappingExposure: 1 } as THREE.WebGLRenderer;
    const environment = { intensity: 1, rotationDegrees: 0 };
    const config: LevelConfig = {
      level: { exposure: 1.4, environmentIntensity: 0.8, environmentRotationY: 35 },
      objects: [
        {
          name: 'Player', type: 'Group', position: [1, 2, 3], rotation: [0, 0.5, 0],
          scale: [2, 2, 2], visible: true,
        },
        {
          name: 'Fill Point', type: 'PointLight', position: [0, 1, 0], rotation: [0, 0, 0],
          scale: [1, 1, 1], visible: true, properties: { color: '#ff0000', intensity: 4, distance: 7 },
        },
      ],
      materials: [{
        uuid: 'saved-runtime-id',
        name: 'Glass',
        type: 'MeshPhysicalMaterial',
        properties: { opacity: 0.6, transparent: true, transmission: 0.75, ior: 1.4 },
      }],
    };

    applyLevelConfig(config, {
      scene,
      renderer,
      studioEnvironment: environment as never,
    });

    expect(player.position.toArray()).toEqual([1, 2, 3]);
    expect(player.scale.toArray()).toEqual([2, 2, 2]);
    expect(light.intensity).toBe(4);
    expect(light.distance).toBe(7);
    expect(light.color.getHexString()).toBe('ff0000');
    expect(glass.transmission).toBe(0.75);
    expect(glass.ior).toBe(1.4);
    expect(renderer.toneMappingExposure).toBe(1.4);
    expect(environment).toEqual({ intensity: 0.8, rotationDegrees: 35 });
  });
});
