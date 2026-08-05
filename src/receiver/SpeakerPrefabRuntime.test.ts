import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

interface GlbJson {
  materials?: Array<{ name?: string }>;
  nodes?: Array<{ name?: string }>;
}

async function readGlbJson(path: URL): Promise<GlbJson> {
  const bytes = await readFile(path);
  expect(bytes.toString('ascii', 0, 4)).toBe('glTF');
  const jsonLength = bytes.readUInt32LE(12);
  return JSON.parse(bytes.toString('utf8', 20, 20 + jsonLength).replace(/\0+$/g, '').trim()) as GlbJson;
}

describe('SM_Speaker1 asset contract', () => {
  it('contains the streamed PBR material slot', async () => {
    const glb = await readGlbJson(new URL('../../assets/Prefabs/SM_Speaker1.glb', import.meta.url));
    expect(glb.materials?.some((material) => material.name?.trim() === 'M_Speaker1')).toBe(true);
    expect(glb.nodes?.map((node) => node.name)).toEqual(expect.arrayContaining([
      'SP_SpeakerLow1',
      'SP_SpeakerHigh1',
      'SM_Speaker1_MembraneLow',
      'SM_Speaker1_MembraneHigh',
    ]));
  });
});
