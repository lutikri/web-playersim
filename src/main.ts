import * as THREE from 'three';
import { Store } from './app/Store';
import levelConfigJson from './config/level-config.json';
import { applyLevelConfig, type LevelConfig } from './config/LevelConfigRuntime';
import { DebugPanel } from './debug/DebugPanel';
import { InteractionRuntime } from './interaction/InteractionRuntime';
import { PostProcessingRuntime } from './postprocessing/PostProcessingRuntime';
import { PhysicsRuntime } from './physics/PhysicsRuntime';
import { CameraRuntime } from './scene/CameraRuntime';
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
const status = requireElement<HTMLElement>('#status');
const debugToggle = requireElement<HTMLButtonElement>('#debug-toggle');

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
let debugPanel: DebugPanel | null = null;
let disposed = false;
let shadowBurstSeconds = 1;
let idleShadowElapsed = 0;

function updateStatus(): void {
  const state = store.getState();
  const power = state.power === 'starting' ? 'STARTING' : state.power.toUpperCase();
  const disc = state.discLocation === 'player' ? 'CD LOADED' : state.discLocation === 'dragging' ? 'MOVING CD' : 'CD READY';
  status.textContent = `${power}  /  ${state.selectedSource.toUpperCase()}  /  ${state.transport.toUpperCase()}  /  ${state.volumeDb} dB  /  ${disc}`;
}

store.subscribe(updateStatus);
store.subscribe(() => {
  shadowBurstSeconds = 1;
});
updateStatus();

async function start(): Promise<void> {
  try {
    const bindings = await sceneRuntime.load();
    applyLevelConfig(levelConfig, { scene, renderer, studioEnvironment });
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
    debugPanel = new DebugPanel(
      scene,
      camera,
      canvas,
      renderer,
      sceneRuntime,
      studioEnvironment,
      postProcessing,
    );
    debugToggle.addEventListener('click', () => debugPanel?.toggle());
    textureStreaming.startDeferredUpgrades();
    loading.classList.add('is-hidden');
  } catch (error) {
    loading.textContent = error instanceof Error ? error.message : 'Scene loading failed.';
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
  interactionRuntime?.update(deltaSeconds);
  physicsRuntime?.update(deltaSeconds);
  sceneRuntime.update(deltaSeconds);
  postProcessing.render(deltaSeconds);
});

function resize(): void {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  postProcessing.resize(window.innerWidth, window.innerHeight);
}

function dispose(): void {
  if (disposed) return;
  disposed = true;
  renderer.setAnimationLoop(null);
  interactionRuntime?.dispose();
  physicsRuntime?.dispose();
  debugPanel?.dispose();
  cameraRuntime.dispose();
  sceneRuntime.dispose();
  textureStreaming.dispose();
  studioEnvironment.dispose();
  postProcessing.dispose();
  renderer.dispose();
}

window.addEventListener('resize', resize);
window.addEventListener('beforeunload', dispose, { once: true });
void start();
