# Codex Working Contract

This is a Vite + TypeScript + Three.js interactive CD receiver experience.

`src/main.ts` is the application composition root.
Business state is owned by the Store and changed only through typed AppEvents.

## Before editing

1. Run `git status --short`.
2. Existing changes belong to the user. Never discard or rewrite unrelated work.
3. Run `npm run check`.
4. State which system owns the requested behavior and which files are expected to change.
5. Inspect the nearest nested `AGENTS.md` before editing files in that folder.

## Scope discipline

- Change one coherent system per task.
- Prefer 3–5 source files per change.
- Do not perform unrelated cleanup, renames, formatting or asset moves.
- Diagnose first and preserve existing behavior unless a behavior change was requested.
- Add or update a regression test for every state, interaction or lifecycle change.
- Do not create empty controllers merely to match the planned directory structure.

## Composition root

`src/main.ts` may:

- create the renderer, scene and camera;
- create long-lived application services;
- connect Store, effects, input, audio and presentation systems;
- start the render loop;
- own top-level application disposal.

`src/main.ts` must not contain:

- state-transition rules;
- raycast classification;
- drag algorithms;
- audio sequencing;
- animation timelines;
- mesh-name lookup;
- display formatting;
- tutorial logic;
- material construction;
- controller-specific update logic.

Reusable behavior belongs to the system that owns it.

## State ownership

The Store is the only source of business truth.

Use:

USER INPUT
→ TYPED EVENT
→ PURE REDUCER
→ STATE TRANSITION
→ EFFECTS
→ 3D / AUDIO / DOM

Rules:

- Three.js objects must not own receiver state.
- Do not store business state in `Object3D.userData`.
- DOM elements must not own player or transport state.
- Audio nodes must not decide whether the receiver is playing.
- Controllers may cache presentation-only state, such as the current animation handle.
- Do not represent exclusive states with several booleans. Use discriminated unions.
- Static disc/track definitions and mutable runtime state must remain separate.

## Reducer

The reducer must remain pure.

It must not:

- access Three.js objects;
- modify DOM;
- play audio;
- start GSAP;
- use timers;
- load resources;
- mutate the previous state.

Impossible actions must either return the unchanged state or produce an explicitly defined rejection result.

Every important invariant requires a test:

- only one disc may be in the tray;
- only one disc may be dragged;
- playback requires power, closed transport and a loaded disc;
- transport transitions cannot overlap;
- input is blocked during atomic device sequences;
- one disc cannot exist in case, tray and drag state simultaneously.

## Effects and controllers

`EffectManager` is an orchestrator, not a second application root.

It may route a state transition to specialized effect modules, but must not implement every sequence itself.

Prefer separate owners:

- `PowerEffects`
- `TransportEffects`
- `PlaybackEffects`
- `DiscDragRuntime`
- `CameraRuntime`
- `DisplayPresenter`
- `TutorialRuntime`
- `AudioEngine`

Controllers receive narrow dependencies and expose narrow public APIs.

Controllers must not call each other through hidden globals. Coordination happens through Store events or explicit adapters created in the composition root.

## Async sequences

Every animation, loading operation and audio sequence must support cancellation.

Use an `AbortSignal`, generation token or owned GSAP timeline.

Required rules:

- stale animation callbacks must not dispatch completion events;
- a disposed system must not dispatch events;
- powering off cancels incompatible startup/reading operations;
- opening the tray cancels playback and disc-reading effects;
- selecting another case cancels the previous case focus sequence;
- cleanup removes listeners, subscriptions, timers, timelines and audio nodes.

Do not implement multi-step business sequences with scattered `setTimeout` calls.

## Interaction ownership

All pointer targeting belongs to one interaction system.

It owns:

- raycasting;
- nearest valid target selection;
- occlusion;
- hover enter/leave;
- pointer capture;
- interaction distance;
- drag input locking;
- OrbitControls locking;
- cleanup.

A mesh click must only dispatch an event or begin an interaction owned by this system.

Do not add independent `pointermove`, `mousedown` and raycast implementations inside individual controllers.

Buttons, knobs, discs and cases use registered interaction definitions rather than hardcoded checks spread through the project.

## Controlled disc drag

Disc drag is deliberately non-physical.

During drag:

- keep a stable drag plane or authored path;
- preserve the disc’s controlled orientation;
- disable OrbitControls;
- use pointer capture;
- evaluate only registered drop zones;
- show snap preview separately from committed state;
- commit location only after a valid drop event;
- invalid drop returns to the state-owned origin;
- release input locks on pointer cancel, blur and disposal.

Never parent the dragged disc to the camera or cursor.

## Asset contract

Runtime code must not search for arbitrary Blender names throughout the project.

Each GLB is resolved once into a typed asset map and validated immediately.

Required parts fail loudly with a useful error:

- asset path;
- missing object name;
- expected object type;
- owning GLB;
- available nearby names.

Optional parts must be marked explicitly.

Blender requirements:

- stable semantic names;
- correct pivots for buttons, knobs, tray, lids, discs and speaker cones;
- authored anchors for disc placement and camera focus;
- no reliance on Blender suffixes such as `.001`;
- no gameplay meaning inferred from hierarchy accidents.

Replacing placeholder geometry with final GLB assets must not require reducer changes.

## Assets

Keep source and runtime assets separate:

source-assets/
- Blender files
- uncompressed textures
- WAV masters
- artwork sources

public/assets/
- GLB runtime models
- compressed textures
- runtime audio
- optimized artwork

Runtime code loads only from `public/assets/`.

Do not move, rename, convert or delete assets unless explicitly requested.

Centralize asset URLs in registries or definitions. Do not scatter string paths across controllers.

## Materials and rendering performance

Avoid uncontrolled shader permutations.

- Reuse a small number of material families.
- Share materials when their runtime properties are identical.
- Clone a material only when an object needs independent mutable uniforms or values.
- Do not create a new material per mesh by default.
- Limit shadow-casting lights.
- Cap device pixel ratio through quality profiles.
- Keep LOW, MEDIUM and HIGH profiles explicit and deterministic.
- Compile/prewarm only after the final scene, lights and material variants are assembled.
- Loading progress must represent real required work and remain visible until critical render warmup is complete.
- Expensive post-processing is optional polish, not an architectural dependency.

Profile before optimizing. Do not infer cost from texture size alone; shader variants, shadows, DPR and post-processing may dominate startup and frame time.

## Audio

Create one `AudioContext` and unlock/resume it from a real user gesture.

Use separate buses:

MUSIC
FOLEY
AMBIENCE
MASTER

Rules:

- centralize decoding and caching;
- do not decode the same asset repeatedly;
- track and stop owned sources during disposal;
- prevent duplicate loop instances;
- fades belong to the audio system;
- UI, mechanism and music volume are independently configurable;
- handle suspended AudioContext after tab backgrounding;
- report missing or failed audio assets clearly.

Remember that `AudioBufferSourceNode` is one-shot. Recreate it for replay, or use a media-element source when pause/resume and long music tracks make that more appropriate.

## Display and UI

The receiver display is derived from AppState.

Do not maintain independent copies of:

- selected track;
- playback time;
- player status;
- disc count;
- volume.

Temporary messages such as volume display may have presentation timing, but they must not overwrite business state.

Tutorial and debug UI use the same public events as physical 3D controls.

Debug UI must not contain alternate device logic.

## Camera

Camera transitions belong only to `CameraRuntime`.

It owns:

- default orbit pose;
- case focus poses;
- return transition;
- zoom limits;
- input locking;
- cancellation of an interrupted transition.

Other systems may request a named camera transition but must not directly animate the camera.

## Frame loop

Use one render loop with explicit phases:

1. read input;
2. update state-driven runtimes;
3. update animations;
4. update audio analyser presentation;
5. update camera;
6. render.

Do not create extra permanent `requestAnimationFrame` loops inside controllers.

Systems that require frame updates register with the central loop and unregister on disposal.

## Configuration

Timings, limits, thresholds, gains and animation distances belong in typed configuration or immutable registries.

Do not leave unexplained magic numbers in controllers.

Registry:
- shared immutable defaults and asset definitions.

Runtime:
- listeners, timelines, audio nodes, temporary state and cloned objects.

Store:
- business state.

## Verification

Required commands:

npm run typecheck
npm run lint
npm run test
npm run build

`npm run check` should run all four where practical.

For state changes:

- add reducer regression tests;
- test valid and invalid transitions.

For effect changes:

- test emitted events;
- test cancellation and cleanup;
- use fake time where possible.

For asset changes:

- validate required object bindings;
- load the production GLB in an asset-contract test.

Use manual browser testing only for:

- visual feel;
- drag comfort;
- knob sensitivity;
- animation timing;
- audio balance;
- camera composition;
- performance on representative hardware.

At handoff report:

- changed owning systems;
- tests and builds performed;
- unverified visual/audio risks;
- any required Blender or asset work.