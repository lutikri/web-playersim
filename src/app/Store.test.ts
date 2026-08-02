import { describe, expect, it } from 'vitest';
import { appReducer, initialState } from './Store';

describe('appReducer', () => {
  it('runs the guarded power startup transition', () => {
    const starting = appReducer(initialState, { type: 'POWER_PRESSED' });
    expect(starting.power).toBe('starting');
    expect(appReducer(starting, { type: 'POWER_PRESSED' })).toBe(starting);
    expect(appReducer(starting, { type: 'POWER_READY' }).power).toBe('on');
  });

  it('changes and clamps volume only while powered on', () => {
    expect(appReducer(initialState, { type: 'VOLUME_CHANGED', deltaDb: 2 })).toBe(initialState);
    const powered = { ...initialState, power: 'on' as const, volumeDb: -2 };
    expect(appReducer(powered, { type: 'VOLUME_CHANGED', deltaDb: 10 }).volumeDb).toBe(0);
    expect(appReducer(powered, { type: 'VOLUME_CHANGED', deltaDb: -100 }).volumeDb).toBe(-60);
  });

  it('commits a dragged disc only after a valid player drop', () => {
    const open = { ...initialState, transport: 'open' as const };
    const dragging = appReducer(open, { type: 'DISC_DRAG_STARTED' });
    const preview = appReducer(dragging, { type: 'DISC_SNAP_PREVIEW', active: true });
    const dropped = appReducer(preview, { type: 'DISC_DROPPED', target: 'player' });
    expect(dropped).toMatchObject({ discLocation: 'player', snapPreview: false });
    expect(appReducer(dropped, { type: 'DISC_DRAG_STARTED' })).toBe(dropped);
  });

  it('returns an invalid drop to the state-owned origin', () => {
    const dragging = appReducer(initialState, { type: 'DISC_DRAG_STARTED' });
    expect(appReducer(dragging, { type: 'DISC_DROPPED', target: 'origin' })).toEqual(initialState);
  });

  it('guards tray transitions and requires an open lid for disc insertion', () => {
    const opening = appReducer(initialState, { type: 'TRAY_TOGGLE_REQUESTED' });
    expect(opening.transport).toBe('opening');
    expect(appReducer(opening, { type: 'TRAY_TOGGLE_REQUESTED' })).toBe(opening);
    expect(appReducer(opening, { type: 'TRAY_TRANSITION_FINISHED', position: 'closed' })).toBe(opening);

    const open = appReducer(opening, { type: 'TRAY_TRANSITION_FINISHED', position: 'open' });
    expect(open.transport).toBe('open');
    const dragging = appReducer(initialState, { type: 'DISC_DRAG_STARTED' });
    expect(appReducer(dragging, { type: 'DISC_DROPPED', target: 'player' }).discLocation).toBe('table');
  });
});
