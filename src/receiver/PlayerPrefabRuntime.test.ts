import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { composeLocalYRotation } from './PlayerPrefabRuntime';

interface GlbNode {
  name?: string;
}

interface GlbMaterial {
  name?: string;
}

interface GlbJson {
  nodes?: GlbNode[];
  materials?: GlbMaterial[];
}

async function readGlbJson(path: URL): Promise<GlbJson> {
  const bytes = await readFile(path);
  expect(bytes.toString('ascii', 0, 4)).toBe('glTF');
  const jsonLength = bytes.readUInt32LE(12);
  expect(bytes.toString('ascii', 16, 20)).toBe('JSON');
  return JSON.parse(bytes.toString('utf8', 20, 20 + jsonLength).replace(/\0+$/g, '').trim()) as GlbJson;
}

describe('SM_Player1 asset contract', () => {
  it('contains the required behavior anchors and materials', async () => {
    const glb = await readGlbJson(new URL('../../assets/Prefabs/SM_Player1.glb', import.meta.url));
    const nodes = new Set(glb.nodes?.map((node) => node.name));
    const materials = new Set(glb.materials?.map((material) => material.name));

    expect([...nodes]).toEqual(expect.arrayContaining([
      'SOKET_CD',
      'SM_Button_Power',
      'SM_Button_VOLUP',
      'SM_Button_VOLDOWN',
      'SM_CDLid',
      'CDLidRotParent1',
      'BtnScreen_Next',
      'BtnScreen_PlayPause',
      'BtnScreen_Prev',
      'BtnScreen_SELECT',
      'BtnScreen_Stop',
    ]));
    expect([...materials]).toEqual(expect.arrayContaining([
      'M_Player1',
      'M_Screen',
      'M_ScreenGlass1',
      'M_GlassLid1',
      'M_StatusLight1',
      'M_ControlBar',
    ]));
  });

  it('opens the lid around its authored local Y axis', () => {
    const rotation = composeLocalYRotation(new THREE.Quaternion(), Math.PI / 2);
    const offset = new THREE.Vector3(1, 0, 0).applyQuaternion(rotation);
    expect(offset.x).toBeCloseTo(0);
    expect(offset.y).toBeCloseTo(0);
    expect(offset.z).toBeCloseTo(-1);
  });
});
