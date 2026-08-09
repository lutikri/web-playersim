import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  isDiscInSnapRange,
  isDiscPickable,
  shouldCommitClick,
  socketAttractionStrength,
} from './InteractionRuntime';

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

  it('does not let an inserted disc intercept lid clicks while the lid is closed', () => {
    expect(isDiscPickable('player', 'closed')).toBe(false);
    expect(isDiscPickable('player', 'opening')).toBe(false);
    expect(isDiscPickable('player', 'open')).toBe(true);
    expect(isDiscPickable('table', 'closed')).toBe(true);
  });

  it('smoothly attracts the disc as the cursor approaches the projected socket', () => {
    const socket = new THREE.Vector2(0.25, -0.1);
    expect(socketAttractionStrength(socket.clone(), socket)).toBe(1);
    expect(socketAttractionStrength(new THREE.Vector2(0.37, -0.1), socket)).toBeCloseTo(0.5);
    expect(socketAttractionStrength(new THREE.Vector2(0.5, -0.1), socket)).toBe(0);
  });
});
