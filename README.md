# Technics Player Sim

Early interactive prototype for a minimal Three.js CD receiver scene. The level GLB provides prefab markers, and runtime GLBs are placed at those authored transforms.

## Run

```bash
npm install
npm run dev
```

Quality checks:

```bash
npm run check
```

Regenerate GPU-compressed runtime textures after changing a master in `assets-source/textures/`:

```bash
npm run textures
```

The converter skips current outputs. Use `npm run textures:force` to rebuild every tier.

## Controls

- `WASD`: move the free camera
- `Q` / `E`: move down / up
- Right mouse drag: look around
- Left mouse drag: move the CD
- Left click: Power, Volume Up, Volume Down, CD lid
- `DEBUG`: toggle the lil-gui level editor

The CD follows a stable world-space drag plane. Releasing near `SOKET_CD` commits the disc to the player; any other release returns it to its authored `PF_CD1` position.

## Architecture

`Store` owns the business state and changes it only through typed events. `SceneRuntime` resolves level markers and composes prefabs. `PlayerPrefabRuntime` is the model-specific factory/behavior that binds player materials, display, buttons, status light and the authored lid pivot. `InteractionRuntime` is the only pointer/raycast owner. `CameraRuntime` owns free-camera input. `DebugPanel` creates and edits objects, lights, materials and post-processing settings.

The level editor uses an inspector workflow. Select prefab roots from `Objects`, scene lights from `Lights`, or live materials from `Materials`; the separate left-side `Properties` panel is rebuilt for the current selection. TransformControls support translate, rotate and scale. Point and Spot lights expose color, intensity, range, decay and shadow settings; Spot lights also expose angle, penumbra and target. Debug light helpers make non-ambient lights visible in the 3D scene.

`Level > Save to project` posts the current editor state to the local Vite dev server and writes `src/config/level-config.json`. Vite reloads the app and the saved transforms, lights, materials and post-processing settings are applied on startup. This endpoint exists only while running `npm run dev`; production builds remain read-only.

`PostProcessingRuntime` owns the EffectComposer pipeline: bloom, anamorphic glare, flare ghosts, color adjustments, vignette and grain. All parameters are live-editable under `Level > Post Processing` and are stored in the same project config.

Runtime asset URLs are centralized in `SceneRuntime`. Required Blender nodes fail with an explicit asset-path error. Collision meshes matching `UBX_` or `UCX_` are hidden by default and can be inspected from `Level > Show collision`.

Player texture masters remain in ignored `assets-source/textures/`. The converter creates mipmapped KTX2/ETC1S files under `assets/runtime-textures/`. Runtime requires only the 1K tier for its first frame, upgrades one texture set at a time to 4K, and releases the replaced GPU textures after each complete set is applied. The player 8K tier is gated behind 12 seconds of stable 55+ FPS, 8K GPU texture support, at least 8 GB reported device memory when that API is available, and disabled browser data-saving mode. The 2K asteroid masters stop at 2K rather than being upscaled.

Metallic materials are lit by a PMREM-filtered procedural studio environment from `StudioEnvironmentRuntime`. It affects reflections only and does not replace the visible scene background. Tune its strength and Y rotation from `Level > Environment` and `Level > Env rotation Y`.

Scene units are meters. The current receiver is about 0.39 m wide and the CD is about 0.13 m across, so their relative physical scale is already suitable. Keep Blender exports at scale 1 with transforms applied.

## Current scope

This slice covers prefab placement, free camera, physical button feedback, the red/off/blue power indicator sequence, state-driven screen/control bar, the animated CD lid, direct CD drag and player snap, project-backed level editing, and the first post-processing pipeline. Playback/audio, disc cases, LUT grading and advanced screen-space effects remain later systems.
