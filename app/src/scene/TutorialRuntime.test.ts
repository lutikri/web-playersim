import { describe, expect, it } from 'vitest';
import { initialState } from '../app/Store';
import { isTutorialStepComplete } from './TutorialRuntime';

describe('guided tutorial state', () => {
  it('advances only after the corresponding player action completes', () => {
    expect(isTutorialStepComplete('camera', initialState, 'CAM_Overview')).toBe(false);
    expect(isTutorialStepComplete('camera', initialState, 'CAM_PlayerFront')).toBe(true);
    expect(isTutorialStepComplete('power', { ...initialState, power: 'starting' }, 'CAM_PlayerFront')).toBe(false);
    expect(isTutorialStepComplete('power', { ...initialState, power: 'on' }, 'CAM_PlayerFront')).toBe(true);
    expect(isTutorialStepComplete('open-lid', { ...initialState, transport: 'opening' }, null)).toBe(false);
    expect(isTutorialStepComplete('open-lid', { ...initialState, transport: 'open' }, null)).toBe(true);
  });

  it('waits for a loaded, readied and playing disc at the end', () => {
    expect(isTutorialStepComplete('insert-disc', { ...initialState, insertedDiscId: 1 }, null)).toBe(true);
    expect(isTutorialStepComplete('close-lid', { ...initialState, insertedDiscId: 1, transport: 'closed' }, null)).toBe(true);
    expect(isTutorialStepComplete('select-cd', { ...initialState, selectedSource: 'cd' }, null)).toBe(true);
    expect(isTutorialStepComplete('reading', { ...initialState, discReady: true }, null)).toBe(true);
    expect(isTutorialStepComplete('play', { ...initialState, playback: 'playing' }, null)).toBe(true);
  });
});
