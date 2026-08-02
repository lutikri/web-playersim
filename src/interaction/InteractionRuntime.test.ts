import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { isDiscInSnapRange, shouldCommitClick } from './InteractionRuntime';

describe('interaction click release', () => {
  it('commits only when pointer release is over the originally pressed control', () => {
    expect(shouldCommitClick('power', 'power')).toBe(true);
    expect(shouldCommitClick('power', 'volume-up')).toBe(false);
    expect(shouldCommitClick('power', null)).toBe(false);
  });

  it('only previews the player socket while the tray is open', () => {
    const disc = new THREE.Vector3(0.05, 0, 0);
    const socket = new THREE.Vector3();
    expect(isDiscInSnapRange(true, disc, socket)).toBe(true);
    expect(isDiscInSnapRange(false, disc, socket)).toBe(false);
  });
});
