import { describe, expect, it } from 'vitest';
import { appReducer, initialState, type AppState } from './Store';

describe('appReducer', () => {
  it('runs the guarded power startup transition', () => {
    const starting = appReducer(initialState, { type: 'POWER_PRESSED' });
    expect(starting.power).toBe('starting');
    expect(appReducer(starting, { type: 'POWER_PRESSED' })).toBe(starting);
    expect(appReducer(starting, { type: 'POWER_READY' }).power).toBe('on');
  });

  it('changes and clamps volume only while powered on', () => {
    expect(appReducer(initialState, { type: 'VOLUME_CHANGED', delta: 1 })).toBe(initialState);
    const powered = { ...initialState, power: 'on' as const, volume: 98 };
    expect(appReducer(powered, { type: 'VOLUME_CHANGED', delta: 10 }).volume).toBe(99);
    expect(appReducer(powered, { type: 'VOLUME_CHANGED', delta: -100 }).volume).toBe(0);
  });

  it('emits a state tick for a physical volume click while powered off', () => {
    const clicked = appReducer(initialState, { type: 'VOLUME_BUTTON_PRESSED' });
    expect(clicked).not.toBe(initialState);
    expect(clicked.volume).toBe(initialState.volume);
    expect(clicked.power).toBe('off');
  });

  it('cycles receiver inputs only while powered on', () => {
    expect(appReducer(initialState, { type: 'SOURCE_SELECT_PRESSED' })).toBe(initialState);
    let state: AppState = { ...initialState, power: 'on' };
    for (const expected of ['usb', 'fm', 'dab', 'cast', 'bluetooth', 'cd', 'spotify'] as const) {
      state = appReducer(state, { type: 'SOURCE_SELECT_PRESSED' });
      expect(state.selectedSource).toBe(expected);
    }
  });

  it('only plays a loaded CD after reading and stops when the lid opens', () => {
    const track = { id: 1, title: 'Test', durationSeconds: 90, hasCover: true };
    let state: AppState = {
      ...initialState,
      power: 'on',
      selectedSource: 'cd',
      transport: 'closed',
      discs: [{ id: 1, tracks: [track], location: 'player' }],
      insertedDiscId: 1,
      tracks: [track],
    };
    expect(appReducer(state, { type: 'PLAY_PAUSE_PRESSED' })).toBe(state);
    state = appReducer(state, { type: 'CD_READING_FINISHED' });
    expect(state).toMatchObject({ discReading: false, discReady: true });
    state = appReducer(state, { type: 'PLAY_PAUSE_PRESSED' });
    expect(state.playback).toBe('playing');
    state = appReducer(state, { type: 'TRAY_TOGGLE_REQUESTED' });
    expect(state).toMatchObject({ transport: 'opening', playback: 'stopped', discReady: false });
  });

  it('cycles tracks and preserves active playback', () => {
    const tracks = [
      { id: 1, title: 'One', durationSeconds: 60, hasCover: false },
      { id: 2, title: 'Two', durationSeconds: 90, hasCover: true },
    ];
    let state: AppState = { ...initialState, tracks, discReady: true, playback: 'playing' };
    state = appReducer(state, { type: 'TRACK_NEXT_PRESSED' });
    expect(state).toMatchObject({ currentTrackIndex: 1, playback: 'playing', playbackSeconds: 0 });
    state = appReducer(state, { type: 'TRACK_NEXT_PRESSED' });
    expect(state.currentTrackIndex).toBe(0);
    state = appReducer(state, { type: 'TRACK_PREVIOUS_PRESSED' });
    expect(state.currentTrackIndex).toBe(1);
  });

  it('commits a dragged disc only after a valid player drop', () => {
    const track = { id: 1, title: 'Test', durationSeconds: 1, hasCover: false };
    const open = {
      ...initialState,
      discs: [{ id: 1, tracks: [track], location: 'table' as const }],
      transport: 'open' as const,
    };
    const dragging = appReducer(open, { type: 'DISC_DRAG_STARTED', discId: 1 });
    const preview = appReducer(dragging, { type: 'DISC_SNAP_PREVIEW', active: true });
    const dropped = appReducer(preview, { type: 'DISC_DROPPED', discId: 1, target: 'player' });
    expect(dropped).toMatchObject({ insertedDiscId: 1, draggedDiscId: null, tracks: [track], snapPreview: false });
    expect(dropped.discs[0].location).toBe('player');
    const removed = appReducer(dropped, { type: 'DISC_DRAG_STARTED', discId: 1 });
    expect(removed).toMatchObject({ insertedDiscId: null, draggedDiscId: 1, discReady: false });
  });

  it('only removes a loaded disc while the lid is open', () => {
    const track = { id: 1, title: 'Test', durationSeconds: 1, hasCover: false };
    const loaded = {
      ...initialState,
      discs: [{ id: 1, tracks: [track], location: 'player' as const }],
      insertedDiscId: 1,
      tracks: [track],
      discReady: true,
    };
    expect(appReducer(loaded, { type: 'DISC_DRAG_STARTED', discId: 1 })).toBe(loaded);
    const open = { ...loaded, transport: 'open' as const };
    expect(appReducer(open, { type: 'DISC_DRAG_STARTED', discId: 1 })).toMatchObject({
      insertedDiscId: null,
      draggedDiscId: 1,
      discReady: false,
    });
  });

  it('returns an invalid drop to the state-owned origin', () => {
    const track = { id: 1, title: 'Test', durationSeconds: 1, hasCover: false };
    const ready = {
      ...initialState,
      discs: [{ id: 1, tracks: [track], location: 'table' as const }],
    };
    const dragging = appReducer(ready, { type: 'DISC_DRAG_STARTED', discId: 1 });
    expect(appReducer(dragging, { type: 'DISC_DROPPED', discId: 1, target: 'origin' })).toEqual(ready);
  });

  it('keeps an inserted disc active when another album is loaded', () => {
    const firstTrack = { id: 1, title: 'First', durationSeconds: 1, hasCover: false };
    const secondTrack = { id: 2, title: 'Second', durationSeconds: 2, hasCover: true };
    const playing: AppState = {
      ...initialState,
      discs: [{ id: 1, tracks: [firstTrack], location: 'player' }],
      insertedDiscId: 1,
      tracks: [firstTrack],
      playback: 'playing',
    };
    const loaded = appReducer(playing, { type: 'TRACKS_LOADED', discId: 2, tracks: [secondTrack] });
    expect(loaded).toMatchObject({ insertedDiscId: 1, tracks: [firstTrack], playback: 'playing' });
    expect(loaded.discs).toHaveLength(2);
    expect(loaded.discs[1]).toMatchObject({ id: 2, tracks: [secondTrack], location: 'table' });
  });

  it('guards tray transitions and requires an open lid for disc insertion', () => {
    const opening = appReducer(initialState, { type: 'TRAY_TOGGLE_REQUESTED' });
    expect(opening.transport).toBe('opening');
    expect(appReducer(opening, { type: 'TRAY_TOGGLE_REQUESTED' })).toBe(opening);
    expect(appReducer(opening, { type: 'TRAY_TRANSITION_FINISHED', position: 'closed' })).toBe(opening);

    const open = appReducer(opening, { type: 'TRAY_TRANSITION_FINISHED', position: 'open' });
    expect(open.transport).toBe('open');
    const track = { id: 1, title: 'Test', durationSeconds: 1, hasCover: false };
    const dragging = appReducer({
      ...initialState,
      discs: [{ id: 1, tracks: [track], location: 'table' as const }],
    }, { type: 'DISC_DRAG_STARTED', discId: 1 });
    const rejected = appReducer(dragging, { type: 'DISC_DROPPED', discId: 1, target: 'player' });
    expect(rejected).toMatchObject({ insertedDiscId: null, draggedDiscId: null });
    expect(rejected.discs[0].location).toBe('table');
  });
});
