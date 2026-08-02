import { readFile } from 'node:fs/promises';
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { hasMaterialNamed, prepareTiledTexture, replaceMaterialNamed } from './SceneMaterialRuntime';

interface GlbJson {
  materials?: Array<{ name?: string }>;
}

async function readGlbJson(path: URL): Promise<GlbJson> {
  const bytes = await readFile(path);
  expect(bytes.toString('ascii', 0, 4)).toBe('glTF');
  const jsonLength = bytes.readUInt32LE(12);
  return JSON.parse(bytes.toString('utf8', 20, 20 + jsonLength).replace(/\0+$/g, '').trim()) as GlbJson;
}

describe('scene material runtime', () => {
  it('keeps the authored asteroid material contract in Scene0', async () => {
    const glb = await readGlbJson(new URL('../../assets/enviroment/Scene0.glb', import.meta.url));
    expect(glb.materials?.some((material) => material.name === 'M_AsteroidBlack')).toBe(true);
  });

  it('replaces every matching material slot and leaves other slots intact', () => {
    const asteroid = new THREE.MeshStandardMaterial({ name: 'M_AsteroidBlack' });
    const other = new THREE.MeshStandardMaterial({ name: 'Other' });
    const replacement = new THREE.MeshStandardMaterial({ name: 'M_AsteroidBlack' });
    const root = new THREE.Group();
    const first = new THREE.Mesh(new THREE.BoxGeometry(), asteroid);
    const second = new THREE.Mesh(new THREE.BoxGeometry(), [other, asteroid]);
    root.add(first, second);

    expect(hasMaterialNamed([root], 'M_AsteroidBlack')).toBe(true);
    expect(replaceMaterialNamed([root], 'M_AsteroidBlack', replacement)).toEqual(new Set([asteroid]));
    expect(first.material).toBe(replacement);
    expect(second.material).toEqual([other, replacement]);
  });

  it('configures every asteroid map for 4x repeat tiling', () => {
    const texture = prepareTiledTexture(new THREE.Texture(), THREE.SRGBColorSpace);
    expect(texture.wrapS).toBe(THREE.RepeatWrapping);
    expect(texture.wrapT).toBe(THREE.RepeatWrapping);
    expect(texture.repeat.toArray()).toEqual([4, 4]);
  });
});
