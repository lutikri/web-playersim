export type PowerState = 'off' | 'starting' | 'on';
export type DiscLocation = 'table' | 'dragging' | 'player';
export type TransportState = 'closed' | 'opening' | 'open' | 'closing';
export const INPUT_SOURCES = ['spotify', 'usb', 'fm', 'dab', 'cast', 'bluetooth', 'cd'] as const;
export type InputSource = typeof INPUT_SOURCES[number];

export interface AppState {
  power: PowerState;
  volumeDb: number;
  discLocation: DiscLocation;
  snapPreview: boolean;
  transport: TransportState;
  selectedSource: InputSource;
}

export type AppEvent =
  | { type: 'POWER_PRESSED' }
  | { type: 'POWER_READY' }
  | { type: 'VOLUME_CHANGED'; deltaDb: number }
  | { type: 'SOURCE_SELECT_PRESSED' }
  | { type: 'TRAY_TOGGLE_REQUESTED' }
  | { type: 'TRAY_TRANSITION_FINISHED'; position: 'open' | 'closed' }
  | { type: 'DISC_DRAG_STARTED' }
  | { type: 'DISC_SNAP_PREVIEW'; active: boolean }
  | { type: 'DISC_DROPPED'; target: 'player' | 'origin' };

export const initialState: AppState = {
  power: 'off',
  volumeDb: -18,
  discLocation: 'table',
  snapPreview: false,
  transport: 'closed',
  selectedSource: 'spotify',
};

export function appReducer(state: AppState, event: AppEvent): AppState {
  switch (event.type) {
    case 'POWER_PRESSED':
      if (state.power === 'starting') return state;
      return { ...state, power: state.power === 'off' ? 'starting' : 'off' };
    case 'POWER_READY':
      return state.power === 'starting' ? { ...state, power: 'on' } : state;
    case 'VOLUME_CHANGED':
      if (state.power !== 'on') return state;
      return { ...state, volumeDb: Math.min(0, Math.max(-60, state.volumeDb + event.deltaDb)) };
    case 'SOURCE_SELECT_PRESSED': {
      if (state.power !== 'on') return state;
      const nextIndex = (INPUT_SOURCES.indexOf(state.selectedSource) + 1) % INPUT_SOURCES.length;
      return { ...state, selectedSource: INPUT_SOURCES[nextIndex] };
    }
    case 'TRAY_TOGGLE_REQUESTED':
      if (state.transport === 'closed') return { ...state, transport: 'opening' };
      if (state.transport === 'open') return { ...state, transport: 'closing' };
      return state;
    case 'TRAY_TRANSITION_FINISHED':
      if (state.transport === 'opening' && event.position === 'open') return { ...state, transport: 'open' };
      if (state.transport === 'closing' && event.position === 'closed') return { ...state, transport: 'closed' };
      return state;
    case 'DISC_DRAG_STARTED':
      if (state.discLocation !== 'table') return state;
      return { ...state, discLocation: 'dragging' };
    case 'DISC_SNAP_PREVIEW':
      if (state.discLocation !== 'dragging' || state.snapPreview === event.active) return state;
      if (event.active && state.transport !== 'open') return state;
      return { ...state, snapPreview: event.active };
    case 'DISC_DROPPED':
      if (state.discLocation !== 'dragging') return state;
      return {
        ...state,
        discLocation: event.target === 'player' && state.transport === 'open' ? 'player' : 'table',
        snapPreview: false,
      };
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
