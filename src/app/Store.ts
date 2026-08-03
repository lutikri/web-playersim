export type PowerState = 'off' | 'starting' | 'on';
export type DiscLocation = 'table' | 'dragging' | 'player';
export type TransportState = 'closed' | 'opening' | 'open' | 'closing';
export const INPUT_SOURCES = ['spotify', 'usb', 'fm', 'dab', 'cast', 'bluetooth', 'cd'] as const;
export type InputSource = typeof INPUT_SOURCES[number];
export type PlaybackState = 'stopped' | 'playing' | 'paused';

export interface TrackInfo {
  id: number;
  title: string;
  durationSeconds: number;
  hasCover: boolean;
}

export interface DiscInfo {
  id: number;
  tracks: TrackInfo[];
  location: DiscLocation;
}

export interface AppState {
  power: PowerState;
  volume: number;
  discs: DiscInfo[];
  insertedDiscId: number | null;
  draggedDiscId: number | null;
  snapPreview: boolean;
  transport: TransportState;
  selectedSource: InputSource;
  tracks: TrackInfo[];
  currentTrackIndex: number;
  playbackSeconds: number;
  discReading: boolean;
  discReady: boolean;
  playback: PlaybackState;
}

export type AppEvent =
  | { type: 'POWER_PRESSED' }
  | { type: 'POWER_READY' }
  | { type: 'VOLUME_CHANGED'; delta: number }
  | { type: 'SOURCE_SELECT_PRESSED' }
  | { type: 'TRACKS_LOADED'; discId: number; tracks: TrackInfo[] }
  | { type: 'CD_READING_STARTED' }
  | { type: 'CD_READING_STOPPED' }
  | { type: 'CD_READING_FINISHED' }
  | { type: 'PLAY_PAUSE_PRESSED' }
  | { type: 'STOP_PRESSED' }
  | { type: 'TRACK_NEXT_PRESSED' }
  | { type: 'TRACK_PREVIOUS_PRESSED' }
  | { type: 'PLAYBACK_PROGRESS'; seconds: number }
  | { type: 'PLAYBACK_ENDED' }
  | { type: 'TRAY_TOGGLE_REQUESTED' }
  | { type: 'TRAY_TRANSITION_FINISHED'; position: 'open' | 'closed' }
  | { type: 'DISC_DRAG_STARTED'; discId: number }
  | { type: 'DISC_SNAP_PREVIEW'; active: boolean }
  | { type: 'DISC_DROPPED'; discId: number; target: 'player' | 'origin' };

export const initialState: AppState = {
  power: 'off',
  volume: 12,
  discs: [],
  insertedDiscId: null,
  draggedDiscId: null,
  snapPreview: false,
  transport: 'closed',
  selectedSource: 'spotify',
  tracks: [],
  currentTrackIndex: 0,
  playbackSeconds: 0,
  discReading: false,
  discReady: false,
  playback: 'stopped',
};

export function appReducer(state: AppState, event: AppEvent): AppState {
  switch (event.type) {
    case 'POWER_PRESSED':
      if (state.power === 'starting') return state;
      return state.power === 'off'
        ? { ...state, power: 'starting' }
        : { ...state, power: 'off', playback: 'stopped', discReading: false };
    case 'POWER_READY':
      return state.power === 'starting' ? { ...state, power: 'on' } : state;
    case 'VOLUME_CHANGED':
      if (state.power !== 'on') return state;
      return { ...state, volume: Math.min(99, Math.max(0, state.volume + event.delta)) };
    case 'SOURCE_SELECT_PRESSED': {
      if (state.power !== 'on') return state;
      const nextIndex = (INPUT_SOURCES.indexOf(state.selectedSource) + 1) % INPUT_SOURCES.length;
      return {
        ...state,
        selectedSource: INPUT_SOURCES[nextIndex],
        discReading: false,
        discReady: false,
        playback: 'stopped',
      };
    }
    case 'TRACKS_LOADED':
      return {
        ...state,
        discs: [...state.discs, { id: event.discId, tracks: event.tracks, location: 'table' }],
      };
    case 'CD_READING_STARTED':
      if (state.power !== 'on' || state.selectedSource !== 'cd' || state.transport !== 'closed') return state;
      return state.discReading ? state : { ...state, discReading: true, discReady: false };
    case 'CD_READING_STOPPED':
      return state.discReading ? { ...state, discReading: false } : state;
    case 'CD_READING_FINISHED':
      if (state.power !== 'on' || state.selectedSource !== 'cd' || state.transport !== 'closed'
        || state.insertedDiscId === null || state.tracks.length === 0) return state;
      return { ...state, discReading: false, discReady: true };
    case 'PLAY_PAUSE_PRESSED':
      if (state.power !== 'on' || state.selectedSource !== 'cd' || state.transport !== 'closed'
        || state.insertedDiscId === null || !state.discReady || state.tracks.length === 0) return state;
      return { ...state, playback: state.playback === 'playing' ? 'paused' : 'playing' };
    case 'STOP_PRESSED':
      if (state.power !== 'on') return state;
      return { ...state, playback: 'stopped', playbackSeconds: 0 };
    case 'TRACK_NEXT_PRESSED':
    case 'TRACK_PREVIOUS_PRESSED': {
      if (!state.discReady || state.tracks.length === 0) return state;
      const direction = event.type === 'TRACK_NEXT_PRESSED' ? 1 : -1;
      const currentTrackIndex = (state.currentTrackIndex + direction + state.tracks.length) % state.tracks.length;
      return {
        ...state,
        currentTrackIndex,
        playbackSeconds: 0,
        playback: state.playback === 'stopped' ? 'paused' : state.playback,
      };
    }
    case 'PLAYBACK_PROGRESS':
      return state.playback === 'playing' ? { ...state, playbackSeconds: Math.max(0, event.seconds) } : state;
    case 'PLAYBACK_ENDED': {
      if (state.playback === 'stopped') return state;
      const hasNext = state.currentTrackIndex + 1 < state.tracks.length;
      return {
        ...state,
        currentTrackIndex: hasNext ? state.currentTrackIndex + 1 : state.currentTrackIndex,
        playbackSeconds: 0,
        playback: hasNext ? 'playing' : 'stopped',
      };
    }
    case 'TRAY_TOGGLE_REQUESTED':
      if (state.transport === 'closed') return {
        ...state,
        transport: 'opening',
        discReading: false,
        discReady: false,
        playback: 'stopped',
        playbackSeconds: 0,
      };
      if (state.transport === 'open') return { ...state, transport: 'closing' };
      return state;
    case 'TRAY_TRANSITION_FINISHED':
      if (state.transport === 'opening' && event.position === 'open') return { ...state, transport: 'open' };
      if (state.transport === 'closing' && event.position === 'closed') return { ...state, transport: 'closed' };
      return state;
    case 'DISC_DRAG_STARTED': {
      if (state.draggedDiscId !== null) return state;
      const grabbedDisc = state.discs.find((disc) => disc.id === event.discId);
      if (!grabbedDisc) return state;
      if (grabbedDisc.location !== 'table'
        && !(grabbedDisc.location === 'player' && state.transport === 'open')) return state;
      const removingInsertedDisc = state.insertedDiscId === event.discId;
      return {
        ...state,
        discs: state.discs.map((disc) => disc.id === event.discId
          ? { ...disc, location: 'dragging' }
          : disc),
        draggedDiscId: event.discId,
        insertedDiscId: removingInsertedDisc ? null : state.insertedDiscId,
        tracks: removingInsertedDisc ? [] : state.tracks,
        currentTrackIndex: removingInsertedDisc ? 0 : state.currentTrackIndex,
        playbackSeconds: removingInsertedDisc ? 0 : state.playbackSeconds,
        discReading: removingInsertedDisc ? false : state.discReading,
        discReady: removingInsertedDisc ? false : state.discReady,
        playback: removingInsertedDisc ? 'stopped' : state.playback,
      };
    }
    case 'DISC_SNAP_PREVIEW':
      if (state.draggedDiscId === null || state.snapPreview === event.active) return state;
      if (event.active && (state.transport !== 'open' || state.insertedDiscId !== null)) return state;
      return { ...state, snapPreview: event.active };
    case 'DISC_DROPPED': {
      if (state.draggedDiscId !== event.discId) return state;
      const droppedDisc = state.discs.find((disc) => disc.id === event.discId);
      if (!droppedDisc) return state;
      const inserted = event.target === 'player'
        && state.transport === 'open'
        && state.insertedDiscId === null;
      return {
        ...state,
        discs: state.discs.map((disc) => disc.id === event.discId
          ? { ...disc, location: inserted ? 'player' : 'table' }
          : disc),
        insertedDiscId: inserted ? event.discId : state.insertedDiscId,
        draggedDiscId: null,
        tracks: inserted ? droppedDisc.tracks : state.tracks,
        currentTrackIndex: inserted ? 0 : state.currentTrackIndex,
        playbackSeconds: inserted ? 0 : state.playbackSeconds,
        snapPreview: false,
        discReady: inserted ? false : state.discReady,
        playback: inserted ? 'stopped' : state.playback,
      };
    }
  }
}

type Listener = (next: AppState, previous: AppState, event: AppEvent) => void;

export class Store {
  private state: AppState;
  private readonly listeners = new Set<Listener>();

  constructor(state: AppState = initialState) {
    this.state = state;
  }

  getState(): AppState {
    return this.state;
  }

  dispatch = (event: AppEvent): void => {
    const previous = this.state;
    const next = appReducer(previous, event);
    if (next === previous) return;
    this.state = next;
    this.listeners.forEach((listener) => listener(next, previous, event));
  };

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
