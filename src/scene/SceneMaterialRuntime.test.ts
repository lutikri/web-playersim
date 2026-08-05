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
  it('keeps the authored podium material contract in Scene0', async () => {
    const glb = await readGlbJson(new URL('../../assets/enviroment/Scene0.glb', import.meta.url));
    expect(glb.materials?.some((material) => material.name?.trim() === 'M_PodiumMat1')).toBe(true);
  });

  it('replaces every normalized matching material slot and leaves other slots intact', () => {
    const podium = new THREE.MeshStandardMaterial({ name: ' M_PodiumMat1' });
    const other = new THREE.MeshStandardMaterial({ name: 'Other' });
    const replacement = new THREE.MeshStandardMaterial({ name: 'M_PodiumMat1' });
    const root = new THREE.Group();
    const first = new THREE.Mesh(new THREE.BoxGeometry(), podium);
    const second = new THREE.Mesh(new THREE.BoxGeometry(), [other, podium]);
    root.add(first, second);

    expect(hasMaterialNamed([root], 'M_PodiumMat1')).toBe(true);
    expect(replaceMaterialNamed([root], 'M_PodiumMat1', replacement)).toEqual(new Set([podium]));
    expect(first.material).toBe(replacement);
    expect(second.material).toEqual([other, replacement]);
  });

  it('enables repeat wrapping while preserving authored UV scale', () => {
    const texture = prepareTiledTexture(new THREE.Texture(), THREE.SRGBColorSpace);
    expect(texture.wrapS).toBe(THREE.RepeatWrapping);
    expect(texture.wrapT).toBe(THREE.RepeatWrapping);
    expect(texture.repeat.toArray()).toEqual([1, 1]);
  });
});
