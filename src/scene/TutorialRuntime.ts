import * as THREE from 'three';
import type { AppState, Store } from '../app/Store';
import type { SceneBindings } from './SceneRuntime';
import type { CameraRuntime } from './CameraRuntime';

export type TutorialStep = 'camera' | 'power' | 'open-lid' | 'insert-disc' | 'close-lid'
  | 'select-cd' | 'reading' | 'play';

interface TutorialDefinition {
  message: string;
  target?: keyof Pick<SceneBindings,
    'powerButton' | 'lidInteraction' | 'discSocket' | 'sourceSelectButton' | 'playPauseButton'>;
  size?: number;
}

const STORAGE_KEY = 'kernwerk:tutorial:v1';
const STEPS: readonly TutorialStep[] = [
  'camera',
  'power',
  'open-lid',
  'insert-disc',
  'close-lid',
  'select-cd',
  'reading',
  'play',
];
const DEFINITIONS: Record<TutorialStep, TutorialDefinition> = {
  camera: { message: 'Choose the Player Front view', size: 42 },
  power: { message: 'Switch the system on', target: 'powerButton', size: 46 },
  'open-lid': { message: 'Open the CD lid', target: 'lidInteraction', size: 72 },
  'insert-disc': { message: 'Drag a disc into the reader, or load your own track', target: 'discSocket', size: 66 },
  'close-lid': { message: 'Close the CD lid', target: 'lidInteraction', size: 72 },
  'select-cd': { message: 'Select CD as the input', target: 'sourceSelectButton', size: 44 },
  reading: { message: 'Reading disc...' },
  play: { message: 'Press play', target: 'playPauseButton', size: 44 },
};

export function isTutorialStepComplete(
  step: TutorialStep,
  state: AppState,
  cameraPose: string | null,
): boolean {
  switch (step) {
    case 'camera': return cameraPose === 'CAM_PlayerFront';
    case 'power': return state.power === 'on';
    case 'open-lid': return state.transport === 'open';
    case 'insert-disc': return state.insertedDiscId !== null;
    case 'close-lid': return state.insertedDiscId !== null && state.transport === 'closed';
    case 'select-cd': return state.selectedSource === 'cd';
    case 'reading': return state.discReady;
    case 'play': return state.playback === 'playing';
  }
}

function tutorialWasCompleted(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'complete';
  } catch {
    return false;
  }
}

function rememberCompletion(): void {
  try {
    localStorage.setItem(STORAGE_KEY, 'complete');
  } catch {
    // The tutorial still completes when storage is unavailable.
  }
}

export class TutorialRuntime {
  private active = false;
  private visible = false;
  private stepIndex = 0;
  private hideTimer = 0;
  private readonly worldPosition = new THREE.Vector3();
  private readonly projectedPosition = new THREE.Vector3();
  private readonly unsubscribe: () => void;

  constructor(
    private readonly camera: THREE.PerspectiveCamera,
    private readonly cameraRuntime: CameraRuntime,
    private readonly bindings: SceneBindings,
    private readonly store: Store,
    private readonly root: HTMLElement,
    private readonly highlight: HTMLElement,
    private readonly stepLabel: HTMLElement,
    private readonly message: HTMLElement,
    private readonly skipButton: HTMLButtonElement,
    private readonly loadTrackButton: HTMLButtonElement,
  ) {
    this.unsubscribe = store.subscribe(() => this.advanceCompletedSteps());
    skipButton.addEventListener('click', this.skip);
  }

  start(): void {
    const forceTutorial = new URLSearchParams(window.location.search).get('tutorial') === '1';
    if (!forceTutorial && tutorialWasCompleted()) return;
    this.active = true;
  }

  update(): void {
    if (!this.active) return;
    if (!this.visible) {
      if (this.cameraRuntime.currentPoseName !== 'CAM_Overview' || this.cameraRuntime.isTransitioning) return;
      this.visible = true;
      this.root.classList.add('is-visible');
      this.root.setAttribute('aria-hidden', 'false');
      this.renderStep();
    }
    this.advanceCompletedSteps();
    this.positionHighlight();
  }

  dispose(): void {
    window.clearTimeout(this.hideTimer);
    this.unsubscribe();
    this.skipButton.removeEventListener('click', this.skip);
    this.loadTrackButton.classList.remove('is-tutorial-target');
  }

  private advanceCompletedSteps(): void {
    if (!this.active || !this.visible) return;
    let changed = false;
    while (this.stepIndex < STEPS.length && isTutorialStepComplete(
      STEPS[this.stepIndex],
      this.store.getState(),
      this.cameraRuntime.currentPoseName,
    )) {
      this.stepIndex += 1;
      changed = true;
    }
    if (this.stepIndex >= STEPS.length) {
      this.complete();
      return;
    }
    if (changed) this.renderStep();
  }

  private renderStep(): void {
    const step = STEPS[this.stepIndex];
    const definition = DEFINITIONS[step];
    this.stepLabel.textContent = `${String(this.stepIndex + 1).padStart(2, '0')} / ${String(STEPS.length).padStart(2, '0')}`;
    this.message.textContent = definition.message;
    this.root.dataset.step = step;
    this.highlight.style.width = `${definition.size ?? 48}px`;
    this.highlight.style.height = `${definition.size ?? 48}px`;
    this.loadTrackButton.classList.toggle('is-tutorial-target', step === 'insert-disc');
  }

  private positionHighlight(): void {
    if (this.cameraRuntime.isTransitioning) {
      this.highlight.classList.remove('is-visible');
      return;
    }
    const step = STEPS[this.stepIndex];
    if (step === 'camera') {
      const hotspot = document.querySelector<HTMLElement>('[data-camera="CAM_PlayerFront"]');
      if (!hotspot || hotspot.hidden) {
        this.highlight.classList.remove('is-visible');
        return;
      }
      const bounds = hotspot.getBoundingClientRect();
      this.placeHighlight(bounds.left + bounds.width * 0.5, bounds.top + bounds.height * 0.5);
      return;
    }
    const targetName = DEFINITIONS[step].target;
    if (!targetName) {
      this.highlight.classList.remove('is-visible');
      return;
    }
    const target = this.bindings[targetName];
    target.updateWorldMatrix(true, false);
    if (target instanceof THREE.Mesh) {
      target.geometry.computeBoundingSphere();
      this.worldPosition.copy(target.geometry.boundingSphere?.center ?? new THREE.Vector3()).applyMatrix4(target.matrixWorld);
    } else {
      target.getWorldPosition(this.worldPosition);
    }
    this.projectedPosition.copy(this.worldPosition).project(this.camera);
    if (this.projectedPosition.z < -1 || this.projectedPosition.z > 1
      || Math.abs(this.projectedPosition.x) > 1.1 || Math.abs(this.projectedPosition.y) > 1.1) {
      this.highlight.classList.remove('is-visible');
      return;
    }
    this.placeHighlight(
      (this.projectedPosition.x * 0.5 + 0.5) * window.innerWidth,
      (-this.projectedPosition.y * 0.5 + 0.5) * window.innerHeight,
    );
  }

  private placeHighlight(x: number, y: number): void {
    this.highlight.style.transform = `translate3d(${x}px, ${y}px, 0) translate(-50%, -50%)`;
    this.highlight.classList.add('is-visible');
  }

  private complete(): void {
    if (!this.active) return;
    this.active = false;
    rememberCompletion();
    this.cameraRuntime.goToPose('CAM_Overview', 1.6);
    this.loadTrackButton.classList.remove('is-tutorial-target');
    this.highlight.classList.remove('is-visible');
    this.stepLabel.textContent = 'COMPLETE';
    this.message.textContent = 'Continue to explore.';
    this.root.classList.add('is-complete');
    this.hideTimer = window.setTimeout(() => {
      this.root.classList.remove('is-visible');
      this.root.setAttribute('aria-hidden', 'true');
    }, 3_200);
  }

  private readonly skip = (): void => {
    rememberCompletion();
    this.active = false;
    this.loadTrackButton.classList.remove('is-tutorial-target');
    this.highlight.classList.remove('is-visible');
    this.root.classList.remove('is-visible');
    this.root.setAttribute('aria-hidden', 'true');
  };
}
