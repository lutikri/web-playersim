import * as THREE from 'three';
import { Store } from './app/Store';
import { TrackRuntime } from './audio/TrackRuntime';
import { PlayerFoleyRuntime } from './audio/PlayerFoleyRuntime';
import levelConfigJson from './config/level-config.json';
import { applyLevelConfig, type LevelConfig } from './config/LevelConfigRuntime';
import { DebugPanel } from './debug/DebugPanel';
import { InteractionRuntime } from './interaction/InteractionRuntime';
import { PostProcessingRuntime } from './postprocessing/PostProcessingRuntime';
import { PhysicsRuntime } from './physics/PhysicsRuntime';
import { CameraRuntime } from './scene/CameraRuntime';
import { CameraNavigationRuntime } from './scene/CameraNavigationRuntime';
import { SceneRuntime } from './scene/SceneRuntime';
import { StudioEnvironmentRuntime } from './scene/StudioEnvironmentRuntime';
import { TextureStreamingRuntime } from './scene/TextureStreamingRuntime';
import './styles/main.css';

function requireElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Required DOM element not found: ${selector}`);
  return element;
}

const canvas = requireElement<HTMLCanvasElement>('#scene');
const loading = requireElement<HTMLElement>('#loading');
const loadingLabel = requireElement<HTMLElement>('#loading-label');
const loadingProgress = requireElement<HTMLElement>('#loading-progress');
const status = requireElement<HTMLElement>('#status');
const debugToggle = requireElement<HTMLButtonElement>('#debug-toggle');
const loadTrackButton = requireElement<HTMLButtonElement>('#load-track');
const trackFileInput = requireElement<HTMLInputElement>('#track-file');
const cameraNavigationRoot = requireElement<HTMLElement>('#camera-navigation');
const cameraHotspots = requireElement<HTMLElement>('#camera-hotspots');
const cameraBack = requireElement<HTMLButtonElement>('#camera-back');

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight, false);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.shadowMap.autoUpdate = false;
renderer.shadowMap.needsUpdate = true;
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
const levelConfig = levelConfigJson as unknown as LevelConfig;
const postProcessing = new PostProcessingRuntime(renderer, scene, camera, levelConfig.postProcessing);
let interactionRuntime: InteractionRuntime | null = null;
let physicsRuntime: PhysicsRuntime | null = null;
let trackRuntime: TrackRuntime | null = null;
let playerFoleyRuntime: PlayerFoleyRuntime | null = null;
let debugPanel: DebugPanel | null = null;
let cameraNavigation: CameraNavigationRuntime | null = null;
let disposed = false;
let shadowBurstSeconds = 1;
let idleShadowElapsed = 0;

function updateStatus(): void {
  const state = store.getState();
  const power = state.power === 'starting' ? 'STARTING' : state.power.toUpperCase();
  const disc = state.insertedDiscId !== null
    ? `CD ${state.insertedDiscId} LOADED`
    : state.draggedDiscId !== null ? `MOVING CD ${state.draggedDiscId}` : `${state.discs.length} CD${state.discs.length === 1 ? '' : 'S'}`;
  const track = state.tracks[state.currentTrackIndex]?.title ?? 'NO TRACK';
  status.textContent = `${power}  /  ${state.selectedSource.toUpperCase()}  /  ${state.transport.toUpperCase()}  /  VOL ${String(state.volume).padStart(2, '0')}  /  ${disc}  /  ${track}`;
}

store.subscribe(updateStatus);
store.subscribe(() => {
  shadowBurstSeconds = 1;
});
updateStatus();

async function start(): Promise<void> {
  try {
    const bindings = await sceneRuntime.load((progress) => {
      loadingProgress.style.width = `${Math.round(progress * 100)}%`;
    });
    applyLevelConfig(levelConfig, { scene, renderer, studioEnvironment, textureStreaming });
    sceneRuntime.refreshPresentation();
    physicsRuntime = await PhysicsRuntime.create(bindings);
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
    debugToggle.addEventListener('click', () => {
      const visible = debugPanel?.toggle() ?? false;
      debugToggle.setAttribute('aria-pressed', String(visible));
      cameraNavigation?.setDebugMode(visible);
    });
    loadTrackButton.disabled = false;
    textureStreaming.startDeferredUpgrades();
    loadingProgress.style.width = '100%';
    loading.classList.add('is-hidden');
    if (cameraNavigation.isGuided) {
      window.setTimeout(() => cameraNavigation?.playIntro(), 650);
    } else {
      console.warn('[Camera navigation] CAM_Start and CAM_Overview were not found in Scene0.glb. Free camera fallback is active.');
    }
  } catch (error) {
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
  renderer.shadowMap.needsUpdate = shadowBurstSeconds > 0
    || refreshIdleShadow
    || (physicsRuntime?.needsShadowUpdate() ?? false);
  textureStreaming.update(deltaSeconds);
  cameraRuntime.update(deltaSeconds);
  cameraNavigation?.update();
  trackRuntime?.update(deltaSeconds);
  interactionRuntime?.update(deltaSeconds);
  physicsRuntime?.update(deltaSeconds);
  sceneRuntime.update(deltaSeconds);
  postProcessing.render(deltaSeconds);
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
  renderer.setAnimationLoop(null);
  interactionRuntime?.dispose();
  playerFoleyRuntime?.dispose();
  physicsRuntime?.dispose();
  trackRuntime?.dispose();
  debugPanel?.dispose();
  cameraNavigation?.dispose();
  cameraRuntime.dispose();
  sceneRuntime.dispose();
  textureStreaming.dispose();
  studioEnvironment.dispose();
  postProcessing.dispose();
  renderer.dispose();
}

window.addEventListener('resize', resize);
window.addEventListener('beforeunload', dispose, { once: true });
loadTrackButton.addEventListener('click', () => trackFileInput.click());
trackFileInput.addEventListener('change', async () => {
  const files = [...(trackFileInput.files ?? [])];
  if (files.length === 0 || !trackRuntime) return;
  loadTrackButton.disabled = true;
  loadTrackButton.textContent = 'LOADING...';
  try {
    await trackRuntime.loadTracks(files);
    loadTrackButton.textContent = 'LOAD TRACK';
    loadTrackButton.title = `${files.length} track${files.length === 1 ? '' : 's'} loaded`;
  } catch (error) {
    loadTrackButton.textContent = 'LOAD FAILED';
    loadTrackButton.title = error instanceof Error ? error.message : 'Track loading failed.';
    console.error(error);
  } finally {
    loadTrackButton.disabled = false;
    trackFileInput.value = '';
  }
});
void start();
