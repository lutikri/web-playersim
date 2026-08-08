import * as THREE from 'three';
import { Store } from './app/Store';
import { isSupportedTrackFile, TrackRuntime } from './audio/TrackRuntime';
import { PlayerFoleyRuntime } from './audio/PlayerFoleyRuntime';
import levelConfigJson from './config/level-config.json';
import { applyLevelConfig, type LevelConfig } from './config/LevelConfigRuntime';
import { DebugPanel } from './debug/DebugPanel';
import { InteractionRuntime } from './interaction/InteractionRuntime';
import { CursorRuntime } from './interaction/CursorRuntime';
import { PostProcessingRuntime } from './postprocessing/PostProcessingRuntime';
import { PhysicsRuntime } from './physics/PhysicsRuntime';
import { AdaptivePerformanceRuntime, type QualityMode } from './performance/AdaptivePerformanceRuntime';
import { StartupTimings } from './performance/StartupTimings';
import { CameraRuntime } from './scene/CameraRuntime';
import { CameraNavigationRuntime } from './scene/CameraNavigationRuntime';
import { ProductCardRuntime } from './scene/ProductCardRuntime';
import { SceneRuntime } from './scene/SceneRuntime';
import { StudioEnvironmentRuntime } from './scene/StudioEnvironmentRuntime';
import { TextureStreamingRuntime } from './scene/TextureStreamingRuntime';
import { TutorialRuntime } from './scene/TutorialRuntime';

function requireElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Required DOM element not found: ${selector}`);
  return element;
}

const startupTimings = new StartupTimings();

const canvas = requireElement<HTMLCanvasElement>('#scene');
const loading = requireElement<HTMLElement>('#loading');
const loadingLabel = requireElement<HTMLElement>('#loading-label');
const loadingProgress = requireElement<HTMLElement>('#loading-progress');
const loadingPercentage = requireElement<HTMLOutputElement>('#loading-percentage');
const loadingReady = requireElement<HTMLElement>('#loading-ready');
const beginExperience = requireElement<HTMLButtonElement>('#begin-experience');
const loadTrackButton = requireElement<HTMLButtonElement>('#load-track');
const trackFileInput = requireElement<HTMLInputElement>('#track-file');
const cameraNavigationRoot = requireElement<HTMLElement>('#camera-navigation');
const cameraHotspots = requireElement<HTMLElement>('#camera-hotspots');
const cameraBack = requireElement<HTMLButtonElement>('#camera-back');
const productCardsRoot = requireElement<HTMLElement>('#product-cards');
const cursorRing = requireElement<HTMLElement>('#cursor-ring');
const tutorialRoot = requireElement<HTMLElement>('#tutorial');
const tutorialHighlight = requireElement<HTMLElement>('#tutorial-highlight');
const tutorialStep = requireElement<HTMLElement>('#tutorial-step');
const tutorialMessage = requireElement<HTMLElement>('#tutorial-message');
const tutorialSkip = requireElement<HTMLButtonElement>('#tutorial-skip');
const trackDropOverlay = requireElement<HTMLElement>('#track-drop-overlay');
const infoToggle = requireElement<HTMLButtonElement>('#info-toggle');
const infoPanel = requireElement<HTMLElement>('#info-panel');
const infoClose = requireElement<HTMLButtonElement>('#info-close');

const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: false });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight, false);
renderer.shadowMap.enabled = false;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.shadowMap.autoUpdate = false;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.25;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x171a18);
scene.fog = new THREE.Fog(0x171a18, 3, 8);
const studioEnvironment = new StudioEnvironmentRuntime(renderer, scene);
const camera = new THREE.PerspectiveCamera(48, window.innerWidth / window.innerHeight, 0.01, 50);
const ambientLight = new THREE.AmbientLight(0xd7e1df, 1.35);
ambientLight.name = 'Ambient Light';
const keyLight = new THREE.SpotLight(0xfff1dc, 7, 5, Math.PI / 4, 0.55, 1.5);
keyLight.name = 'Key Spot';
keyLight.position.set(1.1, 1.8, 1.3);
keyLight.castShadow = true;
keyLight.shadow.mapSize.set(1024, 1024);
const fillLight = new THREE.PointLight(0x7da5c7, 2.2, 4, 1.7);
fillLight.name = 'Fill Point';
fillLight.position.set(-0.8, 0.8, -0.9);
scene.add(ambientLight, keyLight, fillLight);

const store = new Store();
const textureStreaming = new TextureStreamingRuntime(renderer);
const sceneRuntime = new SceneRuntime(scene, store, studioEnvironment, textureStreaming);
const cameraRuntime = new CameraRuntime(camera, canvas);
const cursorRuntime = new CursorRuntime(cursorRing);
const levelConfig = levelConfigJson as unknown as LevelConfig;
const postProcessing = new PostProcessingRuntime(renderer, scene, camera, levelConfig.postProcessing);
let interactionRuntime: InteractionRuntime | null = null;
let physicsRuntime: PhysicsRuntime | null = null;
let trackRuntime: TrackRuntime | null = null;
let playerFoleyRuntime: PlayerFoleyRuntime | null = null;
let debugPanel: DebugPanel | null = null;
let cameraNavigation: CameraNavigationRuntime | null = null;
let productCardRuntime: ProductCardRuntime | null = null;
let tutorialRuntime: TutorialRuntime | null = null;
let adaptivePerformance: AdaptivePerformanceRuntime | null = null;
let debugVisible = false;
let dragDepth = 0;
let disposed = false;
let waitingForExperience = false;
let shadowBurstSeconds = 1;
let idleShadowElapsed = 0;

const logPointerTarget = (event: PointerEvent): void => {
  const target = event.target instanceof Element ? event.target : null;
  const topElement = document.elementFromPoint(event.clientX, event.clientY);
  console.info('[Input debug] DOM pointerdown', {
    target: target ? `${target.tagName.toLowerCase()}${target.id ? `#${target.id}` : ''}${target.className ? `.${String(target.className).trim().replace(/\s+/g, '.')}` : ''}` : null,
    topElement: topElement ? `${topElement.tagName.toLowerCase()}${topElement.id ? `#${topElement.id}` : ''}${topElement.className ? `.${String(topElement.className).trim().replace(/\s+/g, '.')}` : ''}` : null,
    client: [event.clientX, event.clientY],
  });
};

window.addEventListener('pointerdown', logPointerTarget, { capture: true });

function setLoadingProgress(progress: number): void {
  const percentage = Math.round(THREE.MathUtils.clamp(progress, 0, 1) * 100);
  loadingProgress.style.width = `${percentage}%`;
  loadingPercentage.textContent = `${percentage}%`;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

function enterExperience(): void {
  if (!loading.classList.contains('is-ready') || loading.classList.contains('is-entering')) return;
  beginExperience.disabled = true;
  waitingForExperience = false;
  cameraNavigation?.playIntro();
  tutorialRuntime?.start();
  loading.classList.add('is-entering');
  window.setTimeout(() => {
    loading.classList.add('is-hidden');
    loading.setAttribute('aria-hidden', 'true');
  }, 1_050);
}

function setDebugMode(enabled: boolean): boolean {
  debugVisible = debugPanel?.setVisible(enabled) ?? false;
  cameraNavigation?.setDebugMode(debugVisible);
  productCardRuntime?.setDebugMode(debugVisible);
  return debugVisible;
}

function setInfoVisible(visible: boolean): void {
  infoPanel.classList.toggle('is-visible', visible);
  infoPanel.setAttribute('aria-hidden', String(!visible));
  infoToggle.setAttribute('aria-expanded', String(visible));
}

function isFileDrag(event: DragEvent): boolean {
  return [...(event.dataTransfer?.types ?? [])].includes('Files');
}

function setDropOverlayVisible(visible: boolean): void {
  trackDropOverlay.classList.toggle('is-visible', visible);
  trackDropOverlay.setAttribute('aria-hidden', String(!visible));
}

async function loadTrackFiles(files: File[]): Promise<void> {
  const supportedFiles = files.filter(isSupportedTrackFile);
  if (supportedFiles.length === 0 || !trackRuntime) return;
  loadTrackButton.disabled = true;
  loadTrackButton.textContent = 'LOADING...';
  try {
    await trackRuntime.loadTracks(supportedFiles);
    loadTrackButton.textContent = 'LOAD TRACK';
    loadTrackButton.title = `${supportedFiles.length} track${supportedFiles.length === 1 ? '' : 's'} loaded`;
  } catch (error) {
    loadTrackButton.textContent = 'LOAD FAILED';
    loadTrackButton.title = error instanceof Error ? error.message : 'Track loading failed.';
    console.error(error);
  } finally {
    loadTrackButton.disabled = false;
    trackFileInput.value = '';
  }
}

const onEscape = (event: KeyboardEvent): void => {
  if (event.key !== 'Escape') return;
  setInfoVisible(false);
  if (debugVisible) setDebugMode(false);
  cameraRuntime.goToPose('CAM_Overview', 1.2);
};

const onDragEnter = (event: DragEvent): void => {
  if (!isFileDrag(event) || !loading.classList.contains('is-hidden')) return;
  event.preventDefault();
  dragDepth += 1;
  setDropOverlayVisible(true);
};

const onDragOver = (event: DragEvent): void => {
  if (!isFileDrag(event) || !loading.classList.contains('is-hidden')) return;
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
};

const onDragLeave = (event: DragEvent): void => {
  if (dragDepth === 0) return;
  event.preventDefault();
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) setDropOverlayVisible(false);
};

const onDrop = (event: DragEvent): void => {
  const files = [...(event.dataTransfer?.files ?? [])];
  if (files.length === 0) return;
  event.preventDefault();
  dragDepth = 0;
  setDropOverlayVisible(false);
  void loadTrackFiles(files);
};

const onDragEnd = (): void => {
  dragDepth = 0;
  setDropOverlayVisible(false);
};

const consoleControls = {
  debug: (enabled = true): boolean => setDebugMode(enabled),
  quality: (mode?: QualityMode): QualityMode => {
    if (mode) adaptivePerformance?.setMode(mode);
    return adaptivePerformance?.status.mode ?? mode ?? 'Auto';
  },
  status: (): Record<string, unknown> => adaptivePerformance?.getSnapshot() ?? { state: 'loading' },
  loading: () => startupTimings.report(),
};

Object.defineProperty(window, 'kernwerk', {
  configurable: true,
  value: consoleControls,
});
console.info('[Kernwerk] Controls: kernwerk.status() / kernwerk.loading() / kernwerk.debug() / kernwerk.quality("Auto" | "Ultra" | "High" | "Medium" | "Low")');

store.subscribe(() => {
  shadowBurstSeconds = 1;
});

async function start(): Promise<void> {
  try {
    startupTimings.record('HTML + JS bootstrap', performance.now(), 0);
    const finishSceneLoad = startupTimings.start('Scene load total');
    const bindings = await sceneRuntime.load(
      (progress) => setLoadingProgress(progress * 0.78),
      (label, durationMs) => startupTimings.record(label, durationMs),
    );
    finishSceneLoad();
    setLoadingProgress(0.8);
    const finishLevelSetup = startupTimings.start('Level config + presentation');
    applyLevelConfig(levelConfig, { scene, renderer, studioEnvironment, textureStreaming });
    sceneRuntime.refreshPresentation();
    adaptivePerformance = new AdaptivePerformanceRuntime(renderer, scene, postProcessing);
    finishLevelSetup();
    const finishPhysics = startupTimings.start('Rapier import + physics world');
    physicsRuntime = await PhysicsRuntime.create(bindings);
    finishPhysics();
    interactionRuntime = new InteractionRuntime(
      camera,
      canvas,
      bindings,
      store,
      cameraRuntime,
      sceneRuntime,
      physicsRuntime,
    );
    trackRuntime = new TrackRuntime(
      store,
      camera,
      bindings,
      physicsRuntime,
      sceneRuntime,
      (id, root) => interactionRuntime?.registerDisc(id, root),
    );
    const finishBundledDiscs = startupTimings.start('Bundled discs + audio metadata');
    await trackRuntime.loadBundledDiscs();
    finishBundledDiscs();
    setLoadingProgress(0.87);
    playerFoleyRuntime = new PlayerFoleyRuntime(store, bindings, trackRuntime);
    debugPanel = new DebugPanel(
      scene,
      camera,
      canvas,
      renderer,
      sceneRuntime,
      studioEnvironment,
      postProcessing,
      textureStreaming,
      levelConfig,
      adaptivePerformance,
    );
    cameraNavigation = new CameraNavigationRuntime(
      camera,
      cameraRuntime,
      sceneRuntime.cameraPoses,
      sceneRuntime.cameraHints,
      cameraNavigationRoot,
      cameraHotspots,
      cameraBack,
    );
    productCardRuntime = new ProductCardRuntime(
      camera,
      cameraRuntime,
      sceneRuntime.productCardAnchors,
      productCardsRoot,
    );
    tutorialRuntime = new TutorialRuntime(
      camera,
      cameraRuntime,
      bindings,
      store,
      tutorialRoot,
      tutorialHighlight,
      tutorialStep,
      tutorialMessage,
      tutorialSkip,
      loadTrackButton,
    );
    loadTrackButton.disabled = false;
    textureStreaming.startDeferredUpgrades();
    const finishMediumTextures = startupTimings.start('Medium texture tier prewarm');
    await Promise.all([
      textureStreaming.prewarmMediumTier((progress) => setLoadingProgress(0.88 + progress * 0.02)).finally(finishMediumTextures),
      delay(900),
    ]);
    loadingLabel.textContent = 'ADJUSTING PERFORMANCE';
    loading.classList.add('is-adjusting');
    cameraRuntime.setParallaxEnabled(false);
    cameraRuntime.goToPose('CAM_Overview', 0.001);
    await delay(80);
    const finishCalibration = startupTimings.start('Visible-scene quality calibration');
    await adaptivePerformance.calibrateVisibleScene((progress) => setLoadingProgress(0.9 + progress * 0.09));
    finishCalibration();
    loading.classList.remove('is-adjusting');
    await delay(950);
    cameraRuntime.goToPose('CAM_Start', 0.001);
    await delay(80);
    cameraRuntime.setParallaxEnabled(true);
    setLoadingProgress(0.99);
    setLoadingProgress(1);
    waitingForExperience = true;
    loading.classList.add('is-ready');
    document.documentElement.classList.remove('is-loading-input');
    loadingReady.setAttribute('aria-hidden', 'false');
    loading.setAttribute('role', 'dialog');
    loading.setAttribute('aria-label', 'Begin Kernwerk digital experience');
    beginExperience.focus({ preventScroll: true });
    startupTimings.finish();
    if (!cameraNavigation.isGuided) {
      console.warn('[Camera navigation] CAM_Start and CAM_Overview were not found in Scene0.glb. Free camera fallback is active.');
    }
  } catch (error) {
    document.documentElement.classList.remove('is-loading-input');
    loadingLabel.textContent = error instanceof Error ? error.message : 'Scene loading failed.';
    loading.classList.add('is-error');
    console.error(error);
  }
}

const clock = new THREE.Clock();
renderer.setAnimationLoop(() => {
  const deltaSeconds = Math.min(clock.getDelta(), 0.05);
  shadowBurstSeconds = Math.max(0, shadowBurstSeconds - deltaSeconds);
  idleShadowElapsed += deltaSeconds;
  const refreshIdleShadow = idleShadowElapsed >= 1;
  if (refreshIdleShadow) idleShadowElapsed = 0;
  renderer.shadowMap.needsUpdate = renderer.shadowMap.enabled && (
    shadowBurstSeconds > 0
    || refreshIdleShadow
    || (physicsRuntime?.needsShadowUpdate() ?? false)
  );
  textureStreaming.update(deltaSeconds);
  cursorRuntime.update(deltaSeconds);
  postProcessing.setAutofocusPoint(cursorRuntime.ndc);
  cameraRuntime.update(deltaSeconds);
  cameraNavigation?.update();
  tutorialRuntime?.update();
  productCardRuntime?.update();
  trackRuntime?.update(deltaSeconds);
  interactionRuntime?.update(deltaSeconds);
  physicsRuntime?.update(deltaSeconds);
  sceneRuntime.update(deltaSeconds);
  if (!waitingForExperience) postProcessing.render(deltaSeconds);
  adaptivePerformance?.update();
});

function resize(): void {
  camera.aspect = window.innerWidth / window.innerHeight;
  cameraRuntime.resize();
  camera.updateProjectionMatrix();
  postProcessing.resize(window.innerWidth, window.innerHeight);
}

function dispose(): void {
  if (disposed) return;
  disposed = true;
  window.removeEventListener('pointerdown', logPointerTarget, { capture: true });
  window.removeEventListener('keydown', onEscape);
  window.removeEventListener('dragenter', onDragEnter);
  window.removeEventListener('dragover', onDragOver);
  window.removeEventListener('dragleave', onDragLeave);
  window.removeEventListener('drop', onDrop);
  window.removeEventListener('dragend', onDragEnd);
  renderer.setAnimationLoop(null);
  interactionRuntime?.dispose();
  playerFoleyRuntime?.dispose();
  physicsRuntime?.dispose();
  trackRuntime?.dispose();
  debugPanel?.dispose();
  cameraNavigation?.dispose();
  productCardRuntime?.dispose();
  tutorialRuntime?.dispose();
  cameraRuntime.dispose();
  cursorRuntime.dispose();
  sceneRuntime.dispose();
  textureStreaming.dispose();
  studioEnvironment.dispose();
  postProcessing.dispose();
  renderer.dispose();
}

window.addEventListener('resize', resize);
window.addEventListener('beforeunload', dispose, { once: true });
window.addEventListener('keydown', onEscape);
window.addEventListener('dragenter', onDragEnter);
window.addEventListener('dragover', onDragOver);
window.addEventListener('dragleave', onDragLeave);
window.addEventListener('drop', onDrop);
window.addEventListener('dragend', onDragEnd);
loadTrackButton.addEventListener('click', () => trackFileInput.click());
beginExperience.addEventListener('click', enterExperience);
infoToggle.addEventListener('click', () => setInfoVisible(!infoPanel.classList.contains('is-visible')));
infoClose.addEventListener('click', () => setInfoVisible(false));
trackFileInput.addEventListener('change', () => {
  const files = [...(trackFileInput.files ?? [])];
  if (files.length > 0) void loadTrackFiles(files);
});
void start();
