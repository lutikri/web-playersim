import { readFile } from 'node:fs/promises';
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { applyDiscRadialTangents } from './DiscPrefabRuntime';

interface GlbJson {
  materials?: Array<{ name?: string }>;
  nodes?: Array<{ name?: string }>;
}

async function readGlbJson(path: URL): Promise<GlbJson> {
  const bytes = await readFile(path);
  const jsonLength = bytes.readUInt32LE(12);
  return JSON.parse(bytes.toString('utf8', 20, 20 + jsonLength).replace(/\0+$/g, '').trim()) as GlbJson;
}

describe('SM_CD1 asset contract', () => {
  it('contains its authored collider and material slots', async () => {
    const glb = await readGlbJson(new URL('../../assets/Prefabs/SM_CD1.glb', import.meta.url));
    const nodes = glb.nodes?.map((node) => node.name) ?? [];
    const materials = glb.materials?.map((material) => material.name) ?? [];
    expect(nodes).toContain('UCX_SM_Disk1_01');
    expect(materials).toEqual(expect.arrayContaining([
      'M_DiskGraphic1',
      'M_DiskTransparent',
      'M_DiskMetallic',
      'M_DiskAnisotrophic',
    ]));
  });

  it('generates continuous circumferential vertex tangents from disc geometry', () => {
    const geometry = new THREE.BufferGeometry().setAttribute(
      'position',
      new THREE.Float32BufferAttribute([1, 0, 0, 0, 0, 1, -1, 0, 0], 3),
    );
    applyDiscRadialTangents(geometry);
    const tangents = geometry.getAttribute('tangent');
    expect(tangents.itemSize).toBe(4);
    expect([tangents.getX(0), tangents.getY(0), tangents.getZ(0)]).toEqual([0, 0, 1]);
    expect([tangents.getX(1), tangents.getY(1), tangents.getZ(1)]).toEqual([-1, 0, 0]);
    expect([tangents.getX(2), tangents.getY(2), tangents.getZ(2)]).toEqual([0, 0, -1]);
    geometry.dispose();
  });
});
