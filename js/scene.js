// All Three.js rendering lives here. The scene is a pure view of server state:
// it builds the map + props from config, and each frame reconciles player
// meshes against the latest authoritative snapshot. No game rules here.
import * as THREE from 'three';
// The SAME static/dynamic classifier the physics + referee use, so a fixture that
// became a knockable rigid body isn't ALSO drawn as immovable scenery here (it would
// double-render and leave a ghost collider). Importing the constant does not load
// Rapier — physics.js only fetches the WASM inside loadRapier().
import { isFixedBodyEntry, halfExtentsFor } from '/shared/physics.js';
// Bone-derived hunter sizing — the SAME code the build's headless size check runs
// (shared/hunter-sizing.js), so what ships is exactly what's verified. See the module
// header + memory/notes/hunter-model.md for why measuring the skeleton (not the raw
// 4 mm geometry) is the fix for the tiny/orbiting SWAT model.
import { sizeHunterRig, measureRigBones, findBone } from '/shared/hunter-sizing.js';
// Collider bounds, the ONE shared source (see shared/bounds.js). Used ONLY by the ?debug=1
// wireframe overlay below — the same function the headless misalignment guard reads, so
// what you SEE in debug is exactly what the guard checks and the engine builds.
import { worldColliderBoxes } from '/shared/bounds.js';
// MASTER AUDIO LIMITER — the one output-graph choke point that stops the summed mix clipping. Pure
// Web Audio (no THREE), so the game and the headless check (tools/check-audio-limiter.mjs) run the
// exact same install code. See memory/notes/audio-limiter.md.
import { installMasterLimiter } from '/shared/audio-limiter.js';
// LIGHTING OVERHAUL (VRmike, 2026-07-19): the 4-tier quality rig (SH ambient probe, contact-shadow
// light, angled fill, SSAO/bloom post, tonemap A/B). LightingRig owns the THREE objects; the pure
// tier/tonemap/SH math lives in js/lighting-tiers.js (headless-guarded). See notes/lighting.md.
import { LightingRig } from '/js/lighting.js';
import { resolveTierConfig, mapSHOverride } from '/js/lighting-tiers.js';

// HRTF BINAURAL PANNING for taunt audio (Jie, 2026-07-18). Web Audio's PannerNode has two
// panningModels: 'equalpower' (a cheap constant-power L/R pan — THREE's default) and 'HRTF' (a
// Head-Related Transfer Function that convolves a measured per-ear impulse response, giving true
// binaural 3D on headphones — including the FRONT/BACK and up/down cues equal-power completely
// lacks, so a taunt dead ahead no longer sounds identical to one dead behind). We default to HRTF.
// The exact strings are the Web Audio spec's PanningModelType enum — 'HRTF' uppercase, 'equalpower'
// lowercase; a wrong case is SILENTLY ignored by browsers, so they're taken verbatim from the spec.
//
// CLIENT-SIDE render knob ONLY — this is how audio is rendered on THIS machine, not authoritative
// game data, so it deliberately does NOT live in shared/config/. HRTF costs a bit more CPU per
// emitter than equalpower, and the prop-finder can force ~5+ taunts at once; if a weak phone ever
// stutters, flip `model` to the `fallback` value (globally, or per-platform below) instead of
// reverting the feature. `model` empty/unset ⇒ we fall back automatically, so `fallback` is live.
const TAUNT_PANNING = {
  model: 'HRTF',          // default: real binaural front/back/up/down on headphones
  fallback: 'equalpower', // the safe cheaper value if HRTF ever costs too much (e.g. low-end mobile)
};

// Screen-centre in NDC (0,0) = the fixed reticle at the EXACT middle of the screen.
// ONE shared aim point for every reticle raycast so there's a single crosshair
// system: the disguise-target pick (aimedDisguiseTarget), the hunter fire ray
// (aimDirection) AND the ?debug=1 click-to-inspect / focus box (debugPick) all fire
// through the SAME point. Module-level so those allocate nothing per frame.
// HUNTERS aim through the exact centre; PROPS aim through a point 66% of the way UP
// the screen (NDC y = 2*0.66-1 = +0.32) so the reticle doesn't overlap their own
// third-person body (VRmike 2026-07-12). setAimMode() picks which; the CSS #crosshair
// moves to the same spot via the .prop-aim class — reticle and ray always agree.
const SCREEN_CENTER = new THREE.Vector2(0, 0);
const PROP_AIM_NDC = new THREE.Vector2(0, 0.32);
// +Y unit, reused to orient a tracer cylinder (default axis +Y) toward the shot vector.
const UP_Y = new THREE.Vector3(0, 1, 0);

// Build a mesh for a prop type from the catalog. Returns { mesh, baseY } where
// baseY rests the shape on the ground (y=0). Reused for static props and for
// disguised players.
export function makePropMesh(type, catalog) {
  const c = catalog[type];
  if (!c) return null;
  let geo;
  let baseY;
  const color = new THREE.Color(c.color);
  switch (c.shape) {
    case 'box':
      geo = new THREE.BoxGeometry(c.w, c.h, c.d);
      baseY = c.h / 2;
      break;
    case 'cylinder':
      geo = new THREE.CylinderGeometry(c.r, c.r, c.h, 16);
      baseY = c.h / 2;
      break;
    case 'cone':
      geo = new THREE.ConeGeometry(c.r, c.h, 16);
      baseY = c.h / 2;
      break;
    case 'sphere':
      geo = new THREE.SphereGeometry(c.r, 16, 12);
      baseY = c.r;
      break;
    default:
      geo = new THREE.BoxGeometry(1, 1, 1);
      baseY = 0.5;
  }
  const mesh = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ color }));
  mesh.castShadow = true;
  return { mesh, baseY };
}

// The largest world-space dimension a loaded GLB should be scaled to fit. Derived
// from the catalog entry's primitive footprint so a real mesh lands at roughly the
// intended size regardless of the GLB's native units — or from an explicit
// `modelSize` override for pieces whose primitive box doesn't match (floors, walls,
// pillars, door). See Scene3D._instantiateModel. Exported so the level editor
// sizes spawned meshes exactly the way the game does.
export function targetSizeForEntry(c) {
  if (typeof c.modelSize === 'number') return c.modelSize;
  switch (c.shape) {
    case 'box':
      return Math.max(c.w, c.h, c.d);
    case 'cylinder':
    case 'cone':
      return Math.max(2 * c.r, c.h);
    case 'sphere':
      return 2 * c.r;
    default:
      return 1.5;
  }
}

// Clone a loaded GLB, size it (per-axis `dims` to exact world sizes, a uniform
// measured `scale` = native × scale, or fit-largest-dimension-to-`target`), then
// centre it in x/z and rest its base on y=0. Wrapped in a group so the caller can
// position/rotate/scale it freely regardless of the model's internal origin.
// Module-level + exported so both the game renderer (Scene3D) and the level editor
// build meshes identically — a spawned/edited mesh matches what the game draws.
export function instantiateModel(template, target, dims, scale) {
  const inner = template.clone(true);
  const box = new THREE.Box3().setFromObject(inner);
  const size = new THREE.Vector3();
  box.getSize(size);
  if (dims) {
    // Non-uniform: scale each axis to an exact world size. Guards a zero native
    // extent (a perfectly flat mesh) so a floor keeps its intended thickness.
    inner.scale.set(dims.w / (size.x || 1), dims.h / (size.y || 1), dims.d / (size.z || 1));
  } else if (typeof scale === 'number' && scale > 0) {
    // Measured uniform scale (native * scale) — one factor sizes the whole pack.
    inner.scale.setScalar(scale);
  } else {
    const maxDim = Math.max(size.x, size.y, size.z) || 1;
    inner.scale.setScalar(target / maxDim);
  }
  const box2 = new THREE.Box3().setFromObject(inner);
  const center = new THREE.Vector3();
  box2.getCenter(center);
  inner.position.set(-center.x, -box2.min.y, -center.z);
  inner.traverse((o) => {
    if (o.isMesh) o.castShadow = true;
  });
  const holder = new THREE.Group();
  holder.add(inner);
  return holder;
}

// FLICKER FIX (2026-07-13, for Jie via VRmike). Player-attached models strobe/blink
// from certain camera angles because three.js frustum culling judges "off-screen" from
// a bounding sphere computed ONCE at load: (a) the hunter is a SKINNED animated mesh —
// the animation swings limbs outside the bind-pose sphere, so mid-stride the renderer
// wrongly culls and blinks him; (b) disguise GLBs are cloned + RESCALED at runtime, so
// their volumes can lag the new scale. Fix: for the handful of player-attached objects
// (only ever a few — hunter, disguise, capsule) turn culling OFF so the renderer can
// never skip them, and recompute the geometry bounds so anything that DOES still read
// them (aim raycast, highlight/focus box) stays accurate after a swap/rescale. World
// props/scenery are untouched and keep their normal culling optimization. This is the
// ONE choke point meshForPlayer routes every player mesh through — keep it that way so a
// future refactor can't silently drop the flag (tools/check-flicker.mjs guards it).
// LIGHTING OVERHAUL (2026-07-19): when the active tier has contact shadows on, player-attached
// meshes must CAST (so props/players drop a contact shadow for jump accuracy). This module-level
// flag is toggled by Scene3D._applyShadowFlags() so a mesh built lazily AFTER a tier change (a
// mid-match join, a disguise swap) inherits the current shadow state through this same choke point.
let PLAYER_SHADOWS = false;
export function setPlayerShadowCasting(on) { PLAYER_SHADOWS = !!on; }

export function preparePlayerModel(root) {
  if (!root) return root;
  root.traverse((o) => {
    if (!o.isMesh) return;
    o.frustumCulled = false; // never let animation/rescale blink a player-attached mesh
    o.castShadow = PLAYER_SHADOWS; // contact shadows under props/players (tier >= T1)
    const g = o.geometry;
    if (g) {
      // Refresh bounds so post-swap/rescale raycasts + highlight boxes stay correct
      // (belt-and-braces — culling is already off; harmless if bounds were fine).
      if (typeof g.computeBoundingSphere === 'function') g.computeBoundingSphere();
      if (typeof g.computeBoundingBox === 'function') g.computeBoundingBox();
    }
  });
  return root;
}

export class Scene3D {
  constructor(canvas) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(75, 1, 0.1, 500);
    this.camera.position.set(0, 1.6, 0);
    // HUNTER-TOOLS v1. The camera is part of the scene graph so a first-person weapon
    // VIEWMODEL parented to it (the local hunter's held rifle/box — how tool switching is
    // visible to the shooter themselves) renders. Tracers + muzzle flashes are added
    // directly to the scene. All re-established after buildWorld's scene.clear().
    this.scene.add(this.camera);
    // LIGHTING OVERHAUL: the quality-tier rig. Delegated to for every render() so it can swap in
    // the SSAO/bloom composer; drives the SH probe, contact-shadow light, angled fill + tonemap.
    // Starts at T0 (today's exact look) until main.js applies the saved/auto tier.
    this.lighting = new LightingRig(this.renderer, this.scene, this.camera);
    this._lightingCfg = resolveTierConfig(0);
    this._lastMap = null; // remembered so a runtime tier change can reattach lights to the live world
    this._viewModel = null; // local hunter's held-tool mesh (child of the camera), or null
    this._viewModelTool = null; // tool id the current viewmodel represents (rifle/finder/null)
    // PROP FINDER: the translucent AOE cylinder shown while the finder tool is selected. Built
    // lazily on first use, added straight to the scene (so buildWorld's scene.clear() drops it —
    // we null the handle there). Follows the hunter + recolours ready(green)/cooling(grey) via
    // updateFinderZone. See notes/prop-finder.md.
    this._finderZone = null;
    this._finderZoneRadius = 0;
    this._effects = []; // active shot effects: { tracer, flash, life, max }
    this._blasts = []; // HUNTER GRENADES: active explosion effects: { core, ring, life, max, radius }

    // ---- audio taunts (3D positional) ---------------------------------------
    // A THREE.AudioListener parented to the camera (so the Web Audio listener tracks the
    // player's eye/orientation → real stereo direction) plus one PositionalAudio emitter per
    // taunting player, keyed by player id. Each emitter is a bare Object3D added to the scene and
    // repositioned every frame (updateTauntEmitters) to that player's live world position, so the
    // taunt follows a moving prop. Created LAZILY on the first taunt (never at boot — no audio
    // graph on the headless load check). The listener + emitters use THREE's shared AudioContext,
    // which is unlocked on the first user gesture (unlockAudio) for iOS. See notes/audio-taunts.md.
    this._audioListener = null;
    this._tauntEmitters = new Map(); // playerId -> { obj, sound, endsAt }
    // COMBAT SFX (2026-07-18, VRmike B5): active fire-and-forget POSITIONAL one-shots (gunshot at the
    // muzzle, grenade at the blast, prop ouch at the prop). Each is a PositionalAudio on a bare
    // Object3D at a FIXED world point (unlike taunts, which follow a player); reaped when it finishes
    // (updateTauntEmitters). Routed through the SAME listener → master-limiter path as taunts.
    this._oneShots = []; // [{ obj, sound, endsAt }]
    // MASTER AUDIO LIMITER: the headroom-trim + near-brickwall compressor spliced into the
    // listener's single output hop (listener.gain → preGain → limiter → destination) so the summed
    // mix of overlapping taunts + UI sounds can't clip. Installed lazily alongside the listener
    // (_ensureMasterLimiter). Null until then; fail-silent if audio is unavailable.
    this._masterLimiter = null;
    this._masterPreGain = null;

    this.selfId = null;
    this.catalog = null;
    // Uniform world scale applied to every GLB this map references (map.modelScale).
    // The KayKit pack is internally consistent, so ONE measured factor normalises
    // all of it (see shared/config/asset-dims.json). null => no scale set (older
    // maps / primitive-only maps), in which case models fall back to the legacy
    // fit-largest-dimension-to-target behaviour. A per-catalog-entry `modelScale`
    // overrides this for a single asset.
    this.modelScale = null;
    this.players = new Map(); // id -> { mesh, target:{x,z,yaw}, kind }

    // ---- lazy GLB meshes (real Restaurant Bits models) ----------------------
    // The map first renders with primitive placeholders, then the real GLBs the
    // active map references are loaded and swapped in over them. Everything here is
    // kicked off from buildWorld (match start) — never at page boot — so the
    // GLTFLoader CDN import and the GLB downloads stay off the headless load check.
    this._gltfLoader = null; // created lazily on the first match start
    this._modelCache = new Map(); // '/assets/…​.glb' -> loaded template, or 'failed'
    this._modelSlots = []; // this match's primitives still awaiting their GLB
    this._buildToken = 0; // bumped each buildWorld so stale async loads no-op

    // ---- animated character models (the SWAT hunter) ------------------------
    // The soldier model OTHER players see for a REMOTE hunter (the local hunter
    // stays first-person and never renders their own body this pass). Registry comes
    // from shared/config/character-models.json via cfg.characterModels — DELIBERATELY
    // NOT the props/fixtures catalogs, so a player character never enters the disguise
    // pool or the collider-baking pipeline. Both GLB body (with its animation clips)
    // and the weapon are loaded once per match and rig-safe cloned per hunter.
    this.characterModels = null;
    this._charCache = new Map(); // '/assets/…​.glb' -> {scene, animations} | 'loading' | 'failed'
    this._skeletonUtils = null; // lazily imported; SkeletonUtils.clone keeps skinned rigs intact
    this._weaponVisible = true; // setWeaponVisible() toggles the rifle on every hunter
    // Movement for a remote hunter's animation state machine is DERIVED from the
    // difference between successive snapshots (the snapshot carries no velocity), once
    // per snapshot arrival in syncPlayers — not guessed per render frame.
    this._lastSnapT = 0; // performance.now() of the previous syncPlayers call

    // ---- third-person follow camera -----------------------------------------
    // The local player now sees their OWN model from a camera orbiting behind and
    // slightly above them (default). yaw/pitch (from mouse-look / touch drag) orbit
    // the camera instead of turning a first-person head. A collision ray pulls the
    // camera in when a wall/prop sits between it and the player. `thirdPerson=false`
    // flips back to the classic eye view (toggle: V on desktop).
    this.thirdPerson = true;
    this.selfMesh = null; // the local player's own avatar (only in third-person)
    this.selfKind = null; // appearance signature, so we rebuild on disguise/role change
    this.selfAlive = true;
    this.selfDisguiseType = null; // local player's disguise type (for the OWN collider wire)
    // Local-player collider wires (movement capsule + shot sensor) for the EXISTING collider
    // view. VRmike's bug: that view only drew OTHER players; the local player uses selfMesh
    // (not this.players), so his own capsule never showed. This lightweight entry wraps
    // selfMesh so the SAME _addPlayerColliderWire/_addPlayerShotWire builders draw it too.
    this._selfWireEntry = null;
    this.colliders = []; // walls + static props the camera ray tests against
    this._raycaster = new THREE.Raycaster();
    // Tunables.
    this._camDesiredDist = 5.0; // how far behind the player the camera wants to sit
    this._camHeadY = 1.5; // look-at height on the player (upper body / head)
    this._camHeightBias = 0.4; // extra lift so we look slightly down over them
    this._camMinDist = 1.2; // never pull closer than this (avoids clipping into the model)
    this._camDist = this._camDesiredDist; // smoothed current distance (eased for pull-in/out)
    // Reused scratch vectors (no per-frame allocation in the render loop).
    this._vTarget = new THREE.Vector3();
    this._vDesired = new THREE.Vector3();
    this._vDir = new THREE.Vector3();
    this._vAim = new THREE.Vector3();
    this._qScratch = new THREE.Quaternion(); // reused for awake-prop orientation
    this.propMeshes = new Map(); // id -> dynamic-prop render record (rebuilt per match)

    // ---- crosshair disguise targeting ---------------------------------------
    // aimedDisguiseTarget() raycasts the look direction against the disguisable prop
    // primitives to pick what a PROP would disguise as; highlightProp() outlines it.
    // Reused scratch so the per-frame targeting allocates nothing.
    this._vDisgOrigin = new THREE.Vector3();
    this._vDisgDir = new THREE.Vector3();
    this._disguiseTargets = []; // reused list of raycast targets (disguisable primitives)
    this._highlightId = null; // prop id currently outlined (disguise target), or null
    this._highlightBox = null; // reusable wireframe outline; lazily (re)added after a rebuild
    this._hlBox = new THREE.Box3(); // scratch: highlighted prop's world bounds
    this._hlSize = new THREE.Vector3();
    this._hlCenter = new THREE.Vector3();

    // ---- collider debug overlay (?debug=1) ----------------------------------
    // When the page URL carries ?debug=1, buildWorld draws a wireframe outline of EVERY
    // physics collider in-world (static world geometry from shared/bounds.js; each prop's
    // collider parented to its container so it tracks shoves live). This makes physics
    // bugs SEEABLE — an invisible wall in open space or a collider offset from its mesh is
    // obvious at a glance instead of guessed at. See memory/notes/collider-debug.md.
    this._colliderDebug =
      typeof location !== 'undefined' && typeof URLSearchParams !== 'undefined'
        ? new URLSearchParams(location.search).get('debug') === '1'
        : false;
    // LIVE collider-view toggle (driven by the debug menu, js/debug.js). Seeded ON by
    // ?debug=1 so the two links still differ, but now build/torn-down at runtime via
    // setColliderView() instead of only once per map. Tracks its own added objects so a
    // teardown is clean. Shows ALL colliders: world/fixtures (static group), each prop
    // (parented to its container), and each player CAPSULE (new geometry, same size source).
    this._colliderViewOn = this._colliderDebug;
    this._colliderWires = []; // [{ obj, parent }] prop/world wires added live, for teardown
    this._colliderStaticGroup = null; // the static-world wire group (ground/walls/fixtures)
    this._lastMap = null; // remembered from buildWorld so the toggle can rebuild the overlay
    this._lastCatalog = null;
    this._removedFixtures = new Set(); // hide-spot-removed fixture indices for the active match
    this.rules = null; // set by main.js (ensureScene) so the debug view can mirror thin-wall thickening

    // ---- TRUE Rapier collider overlay (debug menu "True Colliders") ----------
    // DISTINCT from the box/capsule view above. This reads collider shapes STRAIGHT from the
    // live Rapier world (updateTrueColliders is handed a PhysicsWorld each frame) and draws
    // each collider in its REAL form — cuboid / ball / capsule / cylinder / cone / convex hull
    // / trimesh — never re-derived from the visible mesh. The whole point: SEE the actual
    // physics geometry (polygon/mesh colliders) so a hitbox mismatch (VRmike's counter bug) is
    // visible instead of guessed. Drawn in a distinct MAGENTA so where it disagrees with the
    // old AABB-box overlay is obvious. See memory/notes/collider-debug.md.
    this._trueColliderOn = false;
    this._trueColliderGroup = null; // THREE.Group holding all true-shape wires
    this._trueColliderWires = new Map(); // collider.handle -> { obj, key } (geometry built once)
    this._trueSeen = new Set(); // scratch reused each frame to prune vanished colliders

    // ---- debug menu seams (?debug=1, driven by js/debug.js) ------------------
    // FREE CAM: detach the render camera and fly it (setFreeCam/updateFreeCam). Purely
    // rendering-side — the physics player never moves; nothing crosses the network.
    // setCamera() early-returns while this is on so the follow-cam can't fight the fly-cam.
    this._freeCam = false;
    this._fcPos = new THREE.Vector3(); // fly-cam eye position (seeded from the live camera)
    this._specPos = new THREE.Vector3(); // SPECTATOR fly-cam eye position (separate from the debug fly-cam)
    // FOCUS BOX + CLICK-TO-INSPECT: a magenta wireframe around the entity under the
    // crosshair (debugPick), deliberately a DISTINCT colour from the green disguise
    // highlight and the yellow/cyan/red collider-debug wires, and NEVER added to
    // this.colliders (so it can't pollute the camera or disguise-aim raycasts).
    this._focusBoxOn = false;
    this._focusBox = null; // lazily built LineSegments
    this._focusTarget = null; // Object3D currently boxed (or null)
    this._fbBox = new THREE.Box3();
    this._fbSize = new THREE.Vector3();
    this._fbCenter = new THREE.Vector3();
    this._fbEuler = new THREE.Euler();

    this.resize();
    window.addEventListener('resize', () => this.resize());
    // Orientation changes on phones sometimes report the new size a beat late;
    // a deferred re-measure avoids a one-frame letterbox after a rotate.
    window.addEventListener('orientationchange', () => setTimeout(() => this.resize(), 200));

    // Mobile GPUs drop the WebGL context under memory pressure / backgrounding.
    // Preventing the default lets the browser restore it instead of white-screening
    // permanently; Three.js re-uploads its resources on the 'restored' event. The
    // world itself is rebuilt on the next match start (buildWorld), which is the
    // only place that holds the map data.
    canvas.addEventListener('webglcontextlost', (e) => e.preventDefault(), false);
    // LIGHTING OVERHAUL: on restore, the composer's render targets + the shadow map are gone.
    // Rebuild the lighting GPU resources and reattach the lights/probe to the live world (the
    // classic way phones silently lose new render state after a tab-switch). buildWorld handles a
    // full world rebuild on the next match; this covers a restore DURING a match.
    canvas.addEventListener('webglcontextrestored', () => {
      try {
        if (this.lighting) {
          this.lighting.onContextRestored();
          this._reattachLighting(this._lastMap);
        }
      } catch (e) { console.warn('[scene] lighting context-restore failed:', e); }
    }, false);
  }

  resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    if (this.lighting) this.lighting.onResize(w, h);
  }

  // LIGHTING OVERHAUL: the auto-tuner's render-scale probe. `scale` 1 == full resolution; a lower
  // value (~0.7) renders fewer pixels to test whether the frame is GPU-bound (FPS jumps → GPU). We
  // scale the device pixel ratio (capped at 2) and re-size so the composer/passes follow.
  setRenderScale(scale) {
    const s = Math.max(0.3, Math.min(1, Number(scale) || 1));
    this._renderScale = s;
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2) * s);
    this.resize();
  }

  // ---- LIGHTING OVERHAUL wiring (VRmike, 2026-07-19) -------------------------
  // Apply a resolved tier config (from js/lighting-tiers.js resolveTierConfig) to the live scene:
  // swap the effect switches, then reattach lights + shadow flags to the current world. Manual
  // pause-menu picks and the auto-tuner both route through here.
  setLightingTier(cfg) {
    this._lightingCfg = cfg || resolveTierConfig(0);
    if (this.lighting) this.lighting.setTierConfig(this._lightingCfg);
    this._reattachLighting(this._lastMap);
  }

  // Tonemap A/B + exposure (pause menu). Applies straight to the renderer — works on every tier.
  setTonemap(mode, exposure) {
    if (this.lighting) this.lighting.setTonemap(mode, exposure);
  }

  // Re-add the tier's lights/probe/post to the world (buildWorld's scene.clear() drops them) and
  // push the cast/receive-shadow flags onto every mesh. Safe with a null map (no-op-ish).
  _reattachLighting(map) {
    if (!this.lighting) return;
    if (map) {
      // Stash the parsed manual SH override (if the map JSON carries pre-baked coefficients) so the
      // rig uses it instead of baking. mapSHOverride returns null → bake at load.
      if (map.__shOverride === undefined) map.__shOverride = mapSHOverride(map);
      this._lastMap = map;
    }
    this.lighting.reattach(this._lastMap);
    this._applyShadowFlags();
  }

  // Push cast/receive-shadow flags onto the live scene meshes for the current tier. Ground/large
  // flat surfaces receive; everything casts. Also flips the player-mesh choke-point flag so meshes
  // built later (mid-join, disguise swap) inherit the state. Cheap; only runs on tier changes /
  // world rebuilds, never per frame.
  _applyShadowFlags() {
    const on = this.lighting ? this.lighting.shadowsOn : false;
    setPlayerShadowCasting(on);
    this.scene.traverse((o) => {
      if (!o.isMesh) return;
      // The SH probe / lights aren't meshes, so they're skipped. Every world + player mesh casts;
      // everything can also receive so props read against each other and the floor.
      o.castShadow = on;
      o.receiveShadow = on;
    });
  }

  // Rebuild the world for a new match.
  buildWorld(map, propInstances, catalog, characterModels = null, removedFixtures = null) {
    this.catalog = catalog;
    // HIDE-SPOT REMOVAL: indices into map.fixtures the host deleted this match. Skip them in the
    // LOCAL static-scenery loop (no visible mesh, no camera collider) so a removed built-in is
    // truly gone — matching physics._buildStatic, which skips the same set (no invisible wall).
    // Remembered so the live debug collider-view toggle mirrors the removal too.
    this._removedFixtures = removedFixtures instanceof Set ? removedFixtures : new Set(removedFixtures || []);
    // Remember the world so the debug collider-view toggle can (re)build the overlay live.
    this._lastMap = map;
    this._lastCatalog = catalog;
    // scene.clear() (below) drops any existing collider wires; forget the stale trackers so
    // a rebuilt overlay doesn't try to remove objects that no longer exist.
    this._colliderWires = [];
    this._colliderStaticGroup = null;
    this._selfWireEntry = null; // self collider wires were children of the cleared self mesh
    // The true-collider group was added straight to the scene, so scene.clear() below drops it;
    // forget the stale handle + per-handle map so updateTrueColliders rebuilds against the new
    // world (the toggle flag persists so it keeps drawing across a round rebuild).
    this._trueColliderGroup = null;
    this._trueColliderWires.clear();
    // Animated character-model registry (the SWAT hunter). Config doesn't change
    // between matches, so keep any already-set registry when a new build omits it.
    if (characterModels) this.characterModels = characterModels;
    // Measured uniform scale for this map's real meshes (see shared/config/asset-dims.json).
    this.modelScale = typeof map.modelScale === 'number' ? map.modelScale : null;
    // A new match: invalidate any in-flight GLB loads from a previous build and
    // start a fresh slot list (the primitives queued for a real-mesh swap).
    this._buildToken++;
    this._modelSlots = [];
    // Clear previous scene contents.
    this.scene.clear();
    // scene.clear() detaches the camera (and any stray tracers); re-parent the camera so
    // its first-person viewmodel keeps rendering, and force a viewmodel rebuild against the
    // fresh scene (main.js re-applies the tool via applyToolView after buildWorld).
    this.scene.add(this.camera);
    if (this._viewModel) { this.camera.remove(this._viewModel); this._viewModel = null; }
    this._viewModelTool = null;
    // scene.clear() dropped the finder AOE cylinder (it was added straight to the scene); forget
    // the stale handle so updateFinderZone rebuilds it against the fresh world next time.
    this._finderZone = null;
    this._effects = [];
    this._blasts = []; // scene.clear() dropped any live explosion meshes; forget the handles
    // scene.clear() dropped every taunt emitter's Object3D, but a PositionalAudio's source is a
    // Web Audio node wired to the listener — removing it from the SCENE graph does NOT stop the
    // sound. So STOP + disconnect each one (not just forget it), or a taunt from the previous
    // match could keep playing into the new one. The AudioListener lives on the camera (re-added
    // above), so it survives the rebuild.
    this._stopAllTaunts();
    this._stopAllOneShots(); // COMBAT SFX: kill any in-flight gunshot/grenade/ouch one-shots too
    this.players.clear();
    // scene.clear() also drops the self avatar; reset its trackers and the camera's
    // collision set / smoothed distance so a fresh match starts fully zoomed out.
    this.selfMesh = null;
    this.selfKind = null;
    this._selfWireEntry = null;
    this.colliders = [];
    this._camDist = this._camDesiredDist;
    // scene.clear() also dropped the disguise-highlight outline; forget the stale
    // target so it doesn't linger. The wireframe box is re-added lazily on demand
    // (its parent is now null → _ensureHighlightBox re-attaches it to this scene).
    this._highlightId = null;
    // scene.clear() also dropped the debug focus box; forget any stale target so it
    // isn't boxed into the fresh scene (the box itself re-adds lazily on the next pick).
    this._focusTarget = null;

    this.scene.background = new THREE.Color(map.sky || '#87ceeb');
    this.scene.fog = new THREE.Fog(new THREE.Color(map.sky || '#87ceeb'), 40, 120);

    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x444466, 1.0));
    const sun = new THREE.DirectionalLight(0xffffff, 0.8);
    sun.position.set(20, 40, 10);
    this.scene.add(sun);

    // Ground.
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(map.size, map.size),
      new THREE.MeshLambertMaterial({ color: new THREE.Color(map.ground) })
    );
    ground.rotation.x = -Math.PI / 2;
    this.scene.add(ground);

    // Boundary walls so the arena reads as enclosed.
    const half = map.size / 2;
    const wallMaterial = new THREE.MeshLambertMaterial({ color: 0x2a2140 });
    const wallGeo = new THREE.BoxGeometry(map.size, 3, 0.5);
    const walls = [
      [0, -half, 0],
      [0, half, 0],
      [-half, 0, Math.PI / 2],
      [half, 0, Math.PI / 2],
    ];
    for (const [x, z, ry] of walls) {
      const wall = new THREE.Mesh(wallGeo, wallMaterial);
      wall.position.set(x, 1.5, z);
      wall.rotation.y = ry || 0;
      this.scene.add(wall);
      this.colliders.push(wall); // camera pulls in against the arena walls
    }

    // Static world fixtures (immovable building pieces: kitchen appliances,
    // counters, sinks, interior walls, large/anchored tables). These come from
    // the LOCAL map data (`map.fixtures`), NOT from the referee's prop list, so
    // the referee never treats them as disguisable — they are pure scenery +
    // world collision. Every client has maps.json, so they render identically on
    // host and guests with no protocol change. Older maps have no `fixtures` key
    // and are unaffected. See memory/notes/restaurant-map.md.
    const fixtures = map.fixtures || [];
    for (let fi = 0; fi < fixtures.length; fi++) {
      if (this._removedFixtures.has(fi)) continue; // hide-spot-removed built-in: no mesh, no collider
      const f = fixtures[fi];
      const c = catalog[f.type];
      if (!c || !isFixedBodyEntry(c)) continue; // fixed scenery (arch + wall-attached); dynamic fixtures render via propInstances (below)
      const built = makePropMesh(f.type, catalog);
      if (!built) continue;
      // Optional per-object uniform scale (default 1) — authored by the level editor.
      // The primitive geometry is centred at its own origin, so scaling then resting
      // the centre at baseY*s keeps the base flush on the floor. `f.y` is a world
      // offset (unscaled) so a scaled item still sits on the same surface height.
      const s = f.scale || 1;
      built.mesh.scale.setScalar(s);
      built.mesh.position.set(f.x, built.baseY * s + (f.y || 0), f.z);
      built.mesh.rotation.y = f.rot || 0;
      built.mesh.userData.debugFixtureType = f.type; // click-to-inspect: static fixture identity
      this.scene.add(built.mesh);
      this.colliders.push(built.mesh); // camera pulls in against fixtures too
      this._queueModel(f, built.mesh, catalog, null, 0, s); // swap in the real GLB if any
    }

    // Dynamic props (the disguise pool — chairs, stools, crates, dishes, food).
    // Built from the referee's authoritative prop instances; these are the objects
    // props can morph into AND real dynamic rigid bodies the host can shove around.
    //
    // Each prop lives in a CONTAINER Group whose origin is the body CENTRE (== the
    // physics body's translation), so an awake prop's snapshot transform {x,y,z +
    // quaternion} maps straight onto the container. The primitive sits centred at the
    // container origin; a swapped-in GLB is offset down by baseY so its base rests on
    // the floor — both then rotate about the centre exactly as the rigid body does.
    this.propMeshes = new Map(); // id -> { container, primitive, baseY, target, awake }
    for (const p of propInstances) {
      const built = makePropMesh(p.type, catalog);
      if (!built) continue;
      // DISGUISE-ANYTHING (Part B): non-architecture STATIC fixtures (counters, oven,
      // fridge, pillar, door, the vent/extractor…) are now disguisable too — the referee
      // includes them in propInstances so a player can aim at and become them. But their
      // VISIBLE mesh + world collider are already built by the static scenery loop (above)
      // and physics._buildStatic, so here they are added ONLY as an INVISIBLE aim PROXY:
      // the disguise raycast still hits it (Raycaster ignores visibility), and highlightProp
      // fits its footprint — without a second visible mesh or GLB load. Knockable/disguise
      // props (the default) render their primitive normally and swap in a GLB.
      const isStatic = isFixedBodyEntry(catalog[p.type]);
      // Optional per-object uniform scale (default 1) — authored by the level editor.
      // The container origin stays the body CENTRE (== physics translation, what the
      // awake snapshot moves); at rest it sits at baseY*s so the scaled primitive's
      // base rests flush on the floor.
      const s = p.scale || 1;
      const container = new THREE.Group();
      // A mid-round joiner's props carry a live transform (centre + quaternion) so a
      // shoved chair arrives where it actually rests; a fresh match's props carry
      // spawn semantics (floor x/z, surface y-offset, yaw). `moved` picks between them.
      // (Static fixtures are never awake, so they always take the spawn-semantics path.)
      if (Number.isFinite(p.qx)) {
        container.position.set(p.x, p.y, p.z);
        container.quaternion.set(p.qx, p.qy, p.qz, p.qw);
      } else {
        container.position.set(p.x, built.baseY + (p.y || 0), p.z);
        container.rotation.y = p.rot || 0;
      }
      built.mesh.scale.setScalar(s);
      built.mesh.position.set(0, 0, 0); // centred on the container origin
      built.mesh.userData.propId = p.id; // so a disguise-aim raycast maps a hit back to its prop
      if (isStatic) built.mesh.visible = false; // aim proxy only — scenery draws the real mesh
      container.add(built.mesh);
      this.scene.add(container);
      if (!isStatic) this.colliders.push(built.mesh); // camera pulls in against props (static ones via scenery)
      this.propMeshes.set(p.id, {
        container,
        primitive: built.mesh,
        type: p.type, // click-to-inspect / focus-box entity identity
        baseY: built.baseY * s,
        // Disguise eligibility now widens to "renderable mesh AND not architecture"
        // (referee sets disguisable). Architecture (floors/walls) is never in this list.
        disguisable: p.disguisable !== false,
        isStatic, // static fixtures never go awake / never get a moving GLB here
        target: null, // set once the prop first appears AWAKE in a snapshot
        awake: false,
      });
      if (!isStatic) this._queueModel(p, built.mesh, catalog, container, built.baseY * s, s); // swap in the real GLB if any
    }

    // Collider view (?debug=1 by default, or toggled live from the debug menu): draw EVERY
    // collider wireframe from the ONE shared source (shared/bounds.js) — identical geometry to
    // what physics.js builds and tools/check-physics.mjs checks. Static world + each prop +
    // each player capsule are (re)built here in one place so the live toggle and the load-time
    // overlay share exactly the same code.
    if (this._colliderViewOn) this._buildColliderView();

    // Kick off the real-mesh load for everything queued above. Fire-and-forget:
    // primitives are already on screen, so the map is playable instantly and each
    // GLB pops in as it arrives (or never, leaving its primitive — the fallback).
    this._loadModels().catch(() => {});

    // Reset the per-match snapshot-timing used to derive hunter movement velocity,
    // seed the default weapon visibility from config, and kick off the character-model
    // load. Fire-and-forget: a remote hunter shows the neutral capsule until the GLB
    // arrives (then rebuilds to the animated soldier), or forever if it fails to load.
    this._lastSnapT = 0;
    const hcfg = this.characterModels && this.characterModels.hunter;
    this._weaponVisible = !(hcfg && hcfg.weapon && hcfg.weapon.visibleByDefault === false);
    this._loadCharacterModels().catch(() => {});

    // LIGHTING OVERHAUL: scene.clear() (top of buildWorld) dropped the tier's probe + effect
    // lights. Reattach them to the fresh world, (re)bake the SH ambient probe from THIS map's
    // room center behind the "Get ready…" loading banner, and push shadow flags onto the new
    // meshes. The base HemisphereLight+sun above are T0's "current lighting" and always stay.
    this._reattachLighting(map);
  }

  // Record a primitive that has a real GLB to swap in later. `entry` is the map's
  // fixture/prop record (carries type/x/z and optional y/rot); `holder` is the
  // primitive mesh already added to the scene. Called for both fixtures and props.
  _queueModel(entry, holder, catalog, container = null, baseY = 0, objScale = 1) {
    const c = catalog[entry.type];
    if (!c || !c.model) return;
    this._modelSlots.push({
      holder,
      // For a dynamic prop the GLB is parented to the prop's container (which the
      // snapshot moves) and offset so its base rests on the floor; for a fixture it
      // is placed once in world space. container == null => fixture path.
      container,
      baseY,
      // Per-object uniform scale (default 1) applied ON TOP of the measured/target
      // sizing below — the editor's "scale" field. Kept separate so the base
      // measured size is unchanged when objScale == 1 (every existing map).
      objScale,
      path: '/assets/' + c.model,
      target: targetSizeForEntry(c),
      // Uniform baked scale (measured): per-entry override, else this map's scale.
      // When set, the GLB is scaled by this factor directly (native * scale) rather
      // than fit-to-target — keeping the whole pack proportionate. `dims` still wins
      // when present (the floor tile's forced-thin non-uniform case).
      scale: typeof c.modelScale === 'number' ? c.modelScale : this.modelScale,
      // Optional non-uniform target dims {w,h,d}. When present the GLB is scaled per
      // axis to these exact world sizes instead of uniformly by its largest
      // dimension — the reliable fix for pieces whose native proportions don't match
      // the intended footprint (e.g. a floor tile that must stay thin however thick
      // its GLB is). Uniform max-dim scaling inflated the kitchen floor's thickness.
      // MEASURED bounds win when present so the mesh matches the physics collider
      // (both baked from asset-dims.json); else the ad-hoc modelDims override.
      dims: c.measured || c.modelDims || null,
      x: entry.x,
      y: entry.y || 0,
      z: entry.z,
      rot: entry.rot || 0,
    });
  }

  setSelf(id) {
    this.selfId = id;
  }

  // Create a mesh matching how a player should currently look. `opts.animated` is
  // set only for REMOTE players (never self): a remote hunter renders as the animated
  // SWAT soldier — this is what props see. The LOCAL hunter is drawn by _syncSelf
  // WITHOUT opts.animated, so they keep the neutral capsule and their first-person
  // view is untouched this pass (you don't see your own body yet).
  meshForPlayer(p, opts = {}) {
    // FLICKER FIX: every player-attached mesh (hunter / disguise GLB / disguise
    // primitive / capsule) goes out through preparePlayerModel — culling OFF + fresh
    // bounds — so animation can't blink the skinned hunter and a rescaled disguise
    // clone can't cull. Single choke point on purpose (see preparePlayerModel).
    return preparePlayerModel(this._buildPlayerMesh(p, opts));
  }

  _buildPlayerMesh(p, opts = {}) {
    if (opts.animated && p.hunter && !p.disguise && this._hunterModelReady()) {
      const soldier = this._buildHunterModel(this.characterModels.hunter);
      if (soldier) return soldier; // else fall through to the capsule (load pending/failed)
    }
    if (p.disguise && this.catalog[p.disguise]) {
      const c = this.catalog[p.disguise];
      // If the disguise's real GLB has already been loaded for this map, wear the
      // real mesh; otherwise (not yet loaded, or it failed) fall back to the
      // primitive so a disguise is always drawn.
      if (c.model) {
        const tmpl = this._modelCache.get('/assets/' + c.model);
        if (tmpl && tmpl !== 'failed') {
          // Disguise renders at the same measured scale as world decor.
          const scale = typeof c.modelScale === 'number' ? c.modelScale : this.modelScale;
          const inst = this._instantiateModel(tmpl, targetSizeForEntry(c), c.measured || c.modelDims || null, scale);
          inst.userData.baseY = 0;
          return inst;
        }
      }
      const built = makePropMesh(p.disguise, this.catalog);
      built.mesh.userData.baseY = built.baseY;
      return built.mesh;
    }
    // Capsule avatar: red for hunters, muted for undisguised props.
    const geo = new THREE.CapsuleGeometry(0.4, 1.0, 4, 12);
    const color = p.hunter ? 0xff5a5a : 0x9a86c4;
    const mesh = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ color }));
    mesh.userData.baseY = 0.9;
    return mesh;
  }

  // Reconcile meshes against a snapshot's player list.
  syncPlayers(players) {
    const seen = new Set();
    // Snapshot cadence (seconds) since the last syncPlayers call — the denominator for
    // deriving a remote hunter's movement velocity (snapshots carry no velocity). Clamp
    // to sane bounds so a paused tab / dropped snapshot can't produce a wild speed.
    const nowT = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    let snapDt = this._lastSnapT ? (nowT - this._lastSnapT) / 1000 : 1 / 15;
    this._lastSnapT = nowT;
    snapDt = Math.min(0.5, Math.max(0.02, snapDt));
    for (const p of players) {
      seen.add(p.id);
      if (p.id === this.selfId) {
        // In third-person the local player sees their OWN model (built via the same
        // disguise/role path everyone else is drawn with, so it matches what the
        // referee and other clients believe this player is). In first-person there
        // is no self avatar (the camera is the eyes). NOTE: no `animated` flag here —
        // the local hunter never renders the SWAT model (stays first-person).
        this._syncSelf(p);
        continue;
      }

      let entry = this.players.get(p.id);
      // `hunter:swat` vs `hunter:cap` fold the model-ready state INTO the kind, so an
      // entry showing the capsule fallback rebuilds into the animated soldier the moment
      // the GLB finishes loading (and a failed load stays a capsule forever).
      let kind = p.disguise ? `d:${p.disguise}` : p.hunter ? 'hunter' : 'prop';
      if (kind === 'hunter') kind = this._hunterModelReady() ? 'hunter:swat' : 'hunter:cap';
      if (!entry || entry.kind !== kind) {
        // New player, or appearance changed (disguised / role / model loaded) -> rebuild.
        if (entry) this.scene.remove(entry.mesh);
        const mesh = this.meshForPlayer(p, { animated: true });
        mesh.position.set(p.x, mesh.userData.baseY + (p.y || 0), p.z);
        mesh.userData.debugPlayerId = p.id; // click-to-inspect / focus-box entity identity
        this.scene.add(mesh);
        entry = {
          mesh,
          kind,
          target: { x: p.x, y: p.y || 0, z: p.z, yaw: p.yaw },
          // Animation controller (mixer + actions + weapon) when this is the animated
          // soldier; null for capsules/disguises. animVel is the derived movement.
          hunterCtl: mesh.userData.hunterCtl || null,
          animVel: null,
          disguiseType: p.disguise || null, // for the debug player-capsule collider wire
          colliderWire: null,
          shotWire: null, // the ?debug=1 SHOT-hitbox (disguise sensor) outline
        };
        this.players.set(p.id, entry);
      }
      // Debug collider view: attach the movement-capsule wire AND the shot-hitbox wire to a
      // new/rebuilt player entry (a disguise change rebuilds the entry, so both re-attach).
      if (this._colliderViewOn && !entry.colliderWire) this._addPlayerColliderWire(entry);
      if (this._colliderViewOn && !entry.shotWire) this._addPlayerShotWire(entry);
      // Derive velocity from this snapshot's displacement BEFORE overwriting target
      // (target still holds the previous snapshot's pose). Smoothed to damp net jitter.
      if (entry.hunterCtl) {
        const vx = (p.x - entry.target.x) / snapDt;
        const vz = (p.z - entry.target.z) / snapDt;
        if (!entry.animVel) entry.animVel = { x: 0, z: 0 };
        entry.animVel.x += (vx - entry.animVel.x) * 0.5;
        entry.animVel.z += (vz - entry.animVel.z) * 0.5;
      }
      entry.target.x = p.x;
      entry.target.y = p.y || 0;
      entry.target.z = p.z;
      entry.target.yaw = p.yaw;
      entry.mesh.visible = p.alive;
      // HELD-TOOL VISIBILITY (B7): show the tool this hunter has selected (host-synced `tool`).
      // Cheap no-op when unchanged; only hunter entries carry a hunterCtl.
      if (entry.hunterCtl) this._applyHeldTool(entry.hunterCtl, p.tool);
    }
    // Remove players no longer present.
    for (const [id, entry] of this.players) {
      if (!seen.has(id)) {
        this.scene.remove(entry.mesh);
        this.players.delete(id);
      }
    }
  }

  // Apply the awake dynamic-prop transforms from a snapshot. Only props the host
  // reported as awake (moving) are here; sleeping props keep their built pose, so
  // most props never touch this. A prop first seen awake starts interpolating from
  // wherever it was built. This is the visible half of the physics TELL — real props
  // get shoved and tumble; a disguised player (kinematic) never does.
  syncProps(awake) {
    if (!this.propMeshes || !awake) return;
    for (const q of awake) {
      const rec = this.propMeshes.get(q.id);
      if (!rec) continue;
      if (!rec.target) rec.target = { x: q.x, y: q.y, z: q.z, qx: q.qx, qy: q.qy, qz: q.qz, qw: q.qw };
      else {
        rec.target.x = q.x;
        rec.target.y = q.y;
        rec.target.z = q.z;
        rec.target.qx = q.qx;
        rec.target.qy = q.qy;
        rec.target.qz = q.qz;
        rec.target.qw = q.qw;
      }
      rec.awake = true;
    }
  }

  // ONE-TIME full world catch-up (host-authoritative object sync). SNAP every dynamic prop that
  // has MOVED (carries a live centre+quaternion) straight to its current transform, so a player just
  // released from the HIDING blindfold — or newly admitted mid-round — sees the world as it actually
  // is (knocked-over objects stay knocked over) instead of the factory-fresh map. Props that never
  // moved (spawn-form entries, no quaternion) are already at their built pose, so they're skipped.
  // Unlike syncProps this SNAPS (no interpolation — the released hunter's screen was blacked out, so
  // there's nothing to smooth from) and does NOT mark props permanently awake; the per-tick awake
  // stream resumes normal interpolation for anything still moving.
  applyWorldSnapshot(list) {
    if (!this.propMeshes || !list) return;
    for (const q of list) {
      if (!Number.isFinite(q.qx)) continue; // never-moved prop — already at its built spawn pose
      const rec = this.propMeshes.get(q.id);
      if (!rec || rec.isStatic) continue;   // unknown id / static aim-proxy (never moves)
      rec.container.position.set(q.x, q.y, q.z);
      rec.container.quaternion.set(q.qx, q.qy, q.qz, q.qw);
      // Keep target coherent so a later interpolate() (if this prop re-wakes) eases from here, not spawn.
      rec.target = { x: q.x, y: q.y, z: q.z, qx: q.qx, qy: q.qy, qz: q.qz, qw: q.qw };
    }
  }

  // Smoothly move other players + awake props toward their latest snapshot pose.
  interpolate(alpha) {
    for (const entry of this.players.values()) {
      const m = entry.mesh;
      m.position.x += (entry.target.x - m.position.x) * alpha;
      m.position.z += (entry.target.z - m.position.z) * alpha;
      const yTarget = (m.userData.baseY || 0) + (entry.target.y || 0);
      m.position.y += (yTarget - m.position.y) * alpha;
      m.rotation.y = entry.target.yaw;
    }
    if (this.propMeshes) {
      for (const rec of this.propMeshes.values()) {
        if (!rec.awake || !rec.target) continue;
        const c = rec.container;
        c.position.x += (rec.target.x - c.position.x) * alpha;
        c.position.y += (rec.target.y - c.position.y) * alpha;
        c.position.z += (rec.target.z - c.position.z) * alpha;
        this._qScratch.set(rec.target.qx, rec.target.qy, rec.target.qz, rec.target.qw);
        c.quaternion.slerp(this._qScratch, alpha);
      }
    }
  }

  // Build/rebuild (or tear down) the local player's own avatar to match their
  // current appearance. Only present in third-person; the mesh is positioned each
  // frame from the PREDICTED local position in setCamera (not the lagging snapshot).
  _syncSelf(p) {
    this.selfAlive = p.alive;
    this.selfDisguiseType = p.disguise || null; // for the OWN movement-capsule / shot-sensor wire
    if (!this._wantSelfMesh()) {
      // First-person (e.g. a HUNTER): the camera is the eyes; draw no own body. The TRUE
      // collider view still shows the local capsule (it reads the physics world, not the mesh).
      this._removeSelfMesh();
      return;
    }
    const kind = p.disguise ? `d:${p.disguise}` : p.hunter ? 'hunter' : 'prop';
    if (!this.selfMesh || this.selfKind !== kind) {
      this._removeSelfMesh();
      this.selfMesh = this.meshForPlayer(p);
      this.selfKind = kind;
      this.selfMesh.userData.debugPlayerId = p.id; // click-to-inspect / focus-box identity
      this.selfMesh.position.set(p.x, this.selfMesh.userData.baseY, p.z);
      this.scene.add(this.selfMesh);
    }
    // EXISTING collider view (box/capsule): attach the LOCAL player's own collider wires so
    // VRmike sees his own hitbox, not only other players'. A disguise change rebuilds selfMesh
    // above, which drops the old wires (children) → _addSelfColliderWires rebuilds them.
    if (this._colliderViewOn) this._addSelfColliderWires();
  }

  // Attach the local player's movement-capsule (green) + shot-sensor (orange) wires to the
  // self mesh, reusing the SAME builders remote players use via a lightweight entry wrapper.
  // Idempotent: skips if the wires already exist on the current self mesh.
  _addSelfColliderWires() {
    if (!this.selfMesh) return;
    if (!this._selfWireEntry || this._selfWireEntry.mesh !== this.selfMesh) {
      // New/rebuilt self mesh → fresh entry (old wires went away with the old mesh).
      this._selfWireEntry = { mesh: this.selfMesh, disguiseType: this.selfDisguiseType, colliderWire: null, shotWire: null };
    } else {
      this._selfWireEntry.disguiseType = this.selfDisguiseType;
    }
    const e = this._selfWireEntry;
    this._addPlayerColliderWire(e);
    this._addPlayerShotWire(e);
  }

  _removeSelfMesh() {
    if (this.selfMesh) this.scene.remove(this.selfMesh);
    this.selfMesh = null;
    this.selfKind = null;
    this._selfWireEntry = null; // the collider wires were children of the removed mesh
  }

  // Draw the local player's OWN avatar when in third-person (props: you see your
  // disguise/capsule), OR while the debug free cam is flying — so a first-person
  // HUNTER can still see their own body from the detached fly-cam. In first-person
  // normal play this is false, so a hunter never renders their own body to themselves
  // (remote players still see the full animated soldier via meshForPlayer).
  _wantSelfMesh() {
    return this.thirdPerson || this._freeCam;
  }

  // Flip between third-person and first-person. main.js drives this off role
  // (HUNTER => first-person, PROP => third-person) and the desktop V toggle. Removing
  // the self avatar immediately keeps first-person from briefly showing the player's
  // own model; it is rebuilt on the next snapshot when switching back (or while the
  // free cam is on, so the body stays visible from the fly-cam).
  setThirdPerson(on) {
    this.thirdPerson = !!on;
    if (!this._wantSelfMesh()) this._removeSelfMesh();
  }

  // Place the camera. Third-person = orbit behind/above the player (collision-aware,
  // smoothed); first-person = classic eye view. yaw/pitch come from the same
  // mouse-look / touch-drag inputs either way — only their interpretation changes.
  // selfYaw (optional) is the facing of the local player's OWN model. It differs
  // from `yaw` (the look/camera yaw) only while disguised with the orientation lock
  // engaged — then the prop stays fixed even as the camera orbits. Defaults to yaw.
  setCamera(pos, yaw, pitch, selfYaw = yaw) {
    // Free cam owns the camera while it's on (js/debug.js drives it via updateFreeCam);
    // the normal follow-cam must not fight it. Park the self body at the player's
    // predicted pose so it stays VISIBLE from the detached fly-cam (this is the only
    // place a first-person hunter's temporarily-shown body gets positioned).
    if (this._freeCam) {
      if (this.selfMesh) {
        this.selfMesh.position.set(pos.x, this.selfMesh.userData.baseY + (pos.y || 0), pos.z);
        this.selfMesh.rotation.y = selfYaw;
        this.selfMesh.visible = this.selfAlive;
      }
      return;
    }
    const py = pos.y || 0; // jump height
    if (!this.thirdPerson) {
      this.camera.position.set(pos.x, 1.6 + py, pos.z);
      this.camera.rotation.set(0, 0, 0, 'YXZ');
      this.camera.rotation.order = 'YXZ';
      this.camera.rotation.y = yaw;
      this.camera.rotation.x = pitch;
      return;
    }

    // Look-at point on the player; keep the own avatar glued to the predicted
    // position/yaw so it tracks the camera without snapshot lag.
    const target = this._vTarget.set(pos.x, this._camHeadY + py, pos.z);
    if (this.selfMesh) {
      this.selfMesh.position.set(pos.x, this.selfMesh.userData.baseY + py, pos.z);
      // Own model faces selfYaw (== look yaw normally; the frozen disguise facing
      // while the orientation lock is on) so a locked disguise doesn't spin as you
      // turn the camera — matching what other players see of you.
      this.selfMesh.rotation.y = selfYaw;
      this.selfMesh.visible = this.selfAlive;
    }
    // Orbit behind/above the target with the collision pull-in (shared with the
    // spectator follow-cam — see spectateFollow).
    this._orbitCameraTo(target, yaw, pitch);
  }

  // Orbit the camera behind/above a look-at `target` (a scratch Vector3) for the given
  // look angles, with the collision pull-in + snap-in/ease-out smoothing. Extracted from
  // the third-person branch of setCamera so the SPECTATOR follow-cam reuses the EXACT same
  // camera behaviour (rather than a second follow-cam that could drift). Camera-forward uses
  // the same convention as first-person / the referee's aim vector.
  _orbitCameraTo(target, yaw, pitch) {
    const cp = Math.cos(pitch);
    const fx = -Math.sin(yaw) * cp;
    const fy = Math.sin(pitch);
    const fz = -Math.cos(yaw) * cp;

    // Desired camera spot: behind (−forward) and lifted a touch. Floor the height
    // so looking far up (which orbits the camera downward) can't sink it below the
    // ground plane (the ground isn't a collider, so nothing else would stop it).
    const dist = this._camDesiredDist;
    const desired = this._vDesired.set(
      target.x - fx * dist,
      Math.max(0.4, target.y - fy * dist + this._camHeightBias),
      target.z - fz * dist
    );

    // Collision pull-in: cast from the target toward the desired spot; if a wall or
    // prop is in the way, clamp the distance so the camera never clips through it.
    const dir = this._vDir.copy(desired).sub(target);
    const desiredLen = dir.length() || 1e-3;
    dir.multiplyScalar(1 / desiredLen);
    let allowed = desiredLen;
    if (this.colliders.length) {
      this._raycaster.set(target, dir);
      this._raycaster.far = desiredLen;
      const hits = this._raycaster.intersectObjects(this.colliders, false);
      if (hits.length) allowed = Math.max(this._camMinDist, hits[0].distance - 0.3);
    }

    // Smooth: snap IN immediately (so we never clip), ease back OUT when clear.
    if (allowed < this._camDist) this._camDist = allowed;
    else this._camDist += (allowed - this._camDist) * 0.12;
    this._camDist = Math.min(this._camDist, desiredLen);

    this.camera.position.copy(target).addScaledVector(dir, this._camDist);
    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(target);
  }

  // ---- crosshair disguise targeting -----------------------------------------
  // Return the id of the disguisable prop the local player is AIMING AT — the first
  // disguisable prop primitive hit by a ray fired from the CAMERA CENTER through the
  // reticle (the fixed screen-centre crosshair), or null. This is the SAME center-
  // screen ray the ?debug=1 inspector uses (debugPick / SCREEN_CENTER), so what the
  // crosshair overlaps is what gets picked — for a first-person hunter that's the eye
  // ray, for a third-person prop the orbit-camera ray — NOT a player-origin cast and
  // NOT "nearest prop". Client-side SELECTION + highlight aid ONLY: the host's
  // applyDisguise re-checks role/phase/range/disguisable from the player's
  // authoritative position, so this can never grant a disguise the referee refuses.
  // Rays test the prop PRIMITIVES, which stay in the scene as (possibly invisible)
  // collision proxies even after a real GLB swaps in — the raycaster still hits them.
  // `yaw`/`pitch` are unused now (the camera, positioned earlier this frame by
  // setCamera, already encodes them); kept in the signature so callers are unchanged.
  // Which fixed reticle point the aim rays fire through: SCREEN_CENTER for hunters,
  // PROP_AIM_NDC (66% up the screen) for props so the crosshair clears the player's own
  // third-person body. main.js flips this alongside the #crosshair .prop-aim CSS class,
  // so the visible reticle and every raycast stay one system.
  setAimMode(propAim) {
    this._aimNDC = propAim ? PROP_AIM_NDC : SCREEN_CENTER;
  }

  aimedDisguiseTarget(pos, yaw, pitch, range) {
    if (!this.propMeshes || !this.propMeshes.size || !this.camera) return null;
    const targets = this._disguiseTargets;
    targets.length = 0;
    for (const rec of this.propMeshes.values()) {
      if (rec.disguisable && rec.primitive) targets.push(rec.primitive);
    }
    if (!targets.length) return null;
    // Fire from the camera through the reticle point. setCamera ran earlier this frame;
    // refresh the world matrix so the ray matches exactly what's rendered.
    this.camera.updateMatrixWorld();
    this._raycaster.setFromCamera(this._aimNDC || SCREEN_CENTER, this.camera);
    const reach = range > 0 ? range : 4.5;
    // The third-person camera sits BEHIND the player, so a prop within `reach` of the
    // player can be up to ~camera-distance farther from the camera itself; extend far
    // enough to reach it, then gate by the player's true reach below. (The host re-
    // checks range authoritatively; this gate only keeps the highlight honest.)
    this._raycaster.far = reach + this._camDesiredDist + 2;
    const hits = this._raycaster.intersectObjects(targets, false);
    if (!hits.length) return null;
    const hit = hits[0];
    const id = hit.object.userData.propId;
    if (id == null) return null;
    // Courtesy range gate from the PLAYER position (matches the host's applyDisguise
    // range check) so you can't highlight a prop you're too far away to become.
    const dx = hit.point.x - pos.x;
    const dz = hit.point.z - pos.z;
    if (Math.hypot(dx, dz) > reach) return null;
    return id;
  }

  // Outline the prop the player would disguise as (id from aimedDisguiseTarget), or
  // clear the outline when id is null / the prop is gone. A SINGLE reused wireframe
  // box is fitted to the target's live world bounds each call, so it tracks a prop
  // even if it's being shoved, and never tints or leaks a shared GLB material.
  highlightProp(id) {
    if (id == null) {
      this._highlightId = null;
      if (this._highlightBox) this._highlightBox.visible = false;
      return;
    }
    const rec = this.propMeshes && this.propMeshes.get(id);
    if (!rec || !rec.container) {
      this._highlightId = null;
      if (this._highlightBox) this._highlightBox.visible = false;
      return;
    }
    this._highlightId = id;
    const box = this._hlBox.setFromObject(rec.container);
    if (box.isEmpty()) {
      if (this._highlightBox) this._highlightBox.visible = false;
      return;
    }
    const b = this._ensureHighlightBox();
    box.getSize(this._hlSize);
    box.getCenter(this._hlCenter);
    b.position.copy(this._hlCenter);
    b.scale.set(this._hlSize.x || 0.1, this._hlSize.y || 0.1, this._hlSize.z || 0.1);
    b.visible = true;
  }

  // Lazily build the reusable disguise-target outline (a unit wireframe box scaled /
  // placed per target). buildWorld's scene.clear() detaches it (parent → null); the
  // parent check re-attaches the same box to the fresh scene, so there's no per-match
  // leak and no null-check needed at the call site.
  _ensureHighlightBox() {
    if (!this._highlightBox) {
      const geo = new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1));
      const mat = new THREE.LineBasicMaterial({ color: 0x7be38b });
      this._highlightBox = new THREE.LineSegments(geo, mat);
      this._highlightBox.renderOrder = 999;
      this._highlightBox.frustumCulled = false; // the box's own bounds are unit-sized
    }
    if (!this._highlightBox.parent) this.scene.add(this._highlightBox);
    return this._highlightBox;
  }

  // ---- lazy GLB meshes ------------------------------------------------------
  // Load the real Restaurant Bits GLBs referenced by THIS map and swap each in over
  // its primitive placeholder. Only the models the active map references are loaded
  // (from this._modelSlots, built during buildWorld). The GLTFLoader itself is a
  // dynamic CDN import done here on the first match start — never at page boot — so
  // the headless load check makes zero external requests (same rule as three.js /
  // PeerJS). Any GLB that is missing or errors just leaves its primitive in place.
  // Lazily import + construct the CDN GLTFLoader (once). Returns true on success,
  // false if the import is blocked (offline / headless) — callers then keep their
  // primitive / capsule fallback. Shared by the prop-mesh loader and the character
  // (hunter) loader so neither fetches anything at page boot.
  async _ensureGltfLoader() {
    if (this._gltfLoader) return true;
    try {
      const mod = await import('three/addons/loaders/GLTFLoader.js');
      this._gltfLoader = new mod.GLTFLoader();
      return true;
    } catch (e) {
      console.warn('[scene] GLTFLoader unavailable — keeping primitive shapes / capsule', e);
      return false;
    }
  }

  async _loadModels() {
    const slots = this._modelSlots;
    if (!slots.length) return;
    const token = this._buildToken;
    if (!(await this._ensureGltfLoader())) {
      return;
    }
    if (token !== this._buildToken) return; // a newer match started while importing
    // Group by GLB path so each file downloads once, then applies to all its uses.
    const byPath = new Map();
    for (const s of slots) {
      if (!byPath.has(s.path)) byPath.set(s.path, []);
      byPath.get(s.path).push(s);
    }
    for (const [path, uses] of byPath) this._loadOne(path, uses, token);
  }

  _loadOne(path, uses, token) {
    const cached = this._modelCache.get(path);
    if (cached === 'failed') return; // known-bad file — keep the primitives
    if (cached) {
      for (const s of uses) this._applyModel(cached, s, token);
      return;
    }
    this._gltfLoader.load(
      path,
      (gltf) => {
        this._modelCache.set(path, gltf.scene);
        for (const s of uses) this._applyModel(gltf.scene, s, token);
      },
      undefined,
      (err) => {
        // Missing or corrupt GLB: record it so we don't retry, and leave every
        // referencing primitive visible. One bad file never blanks the map.
        console.warn('[scene] mesh failed to load, using primitive fallback:', path, err);
        this._modelCache.set(path, 'failed');
      }
    );
  }

  // Place a loaded model into a slot and hide (but keep) its primitive.
  _applyModel(template, slot, token) {
    if (token !== this._buildToken) return; // match ended / restarted; drop it
    const inst = this._instantiateModel(template, slot.target, slot.dims, slot.scale);
    // Per-object editor scale multiplies the measured/target sizing. instantiateModel
    // rests the model's base at the group origin, so scaling about that origin keeps
    // the base flush; the container/world offsets below already account for baseY*s.
    if (slot.objScale && slot.objScale !== 1) inst.scale.multiplyScalar(slot.objScale);
    if (slot.container) {
      // Dynamic prop: parent the GLB to the prop's container (origin == body centre)
      // and drop it by baseY so its base rests on the floor. The container is what
      // the snapshot moves/rotates, so the GLB follows the physics body for free.
      inst.position.set(0, -slot.baseY, 0);
      slot.container.add(inst);
    } else {
      // Fixture: place once in world space.
      inst.position.set(slot.x, slot.y || 0, slot.z);
      inst.rotation.y = slot.rot || 0;
      this.scene.add(inst);
    }
    // Keep the primitive as the (now invisible) camera-collision proxy so the
    // third-person pull-in behaves identically whatever the GLB's real silhouette
    // is — the raycaster still hits it (invisible objects are not skipped). If the
    // GLB had failed instead, the primitive would simply have stayed visible.
    slot.holder.visible = false;
  }

  // Thin wrapper around the shared module-level instantiateModel (kept as a method
  // so existing call sites are unchanged). See instantiateModel above.
  _instantiateModel(template, target, dims, scale) {
    return instantiateModel(template, target, dims, scale);
  }

  // ---- animated character models (the SWAT hunter) --------------------------
  // Load every GLB the character registry references (body + weapon) once per match.
  // Bodies keep their animation clips (needed for the mixer); the weapon is a static
  // mesh. Uses the same lazy CDN GLTFLoader as the prop meshes (nothing at page boot)
  // plus a lazily-imported SkeletonUtils (its .clone keeps skinned rigs intact — a
  // plain .clone() would break the animated skeleton). Any failure leaves hunters as
  // the neutral capsule (a per-file 'failed' marker, no retry).
  async _loadCharacterModels() {
    const reg = this.characterModels;
    if (!reg) return;
    const token = this._buildToken;
    const paths = new Set();
    for (const key of Object.keys(reg)) {
      const cm = reg[key];
      if (!cm || typeof cm !== 'object') continue;
      if (cm.model) paths.add('/assets/' + cm.model);
      if (cm.weapon && cm.weapon.model) paths.add('/assets/' + cm.weapon.model);
    }
    if (!paths.size) return;
    if (!(await this._ensureGltfLoader())) return; // offline/headless -> capsule fallback
    if (token !== this._buildToken) return;
    if (!this._skeletonUtils) {
      try {
        this._skeletonUtils = await import('three/addons/utils/SkeletonUtils.js');
      } catch (e) {
        console.warn('[scene] SkeletonUtils unavailable — hunters keep the capsule', e);
        return;
      }
    }
    if (token !== this._buildToken) return;
    for (const path of paths) this._loadCharacterGlb(path);
  }

  _loadCharacterGlb(path) {
    if (this._charCache.has(path)) return; // loaded, loading, or known-failed
    this._charCache.set(path, 'loading');
    this._gltfLoader.load(
      path,
      (gltf) => this._charCache.set(path, { scene: gltf.scene, animations: gltf.animations || [] }),
      undefined,
      (err) => {
        console.warn('[scene] character GLB failed, hunters keep the capsule:', path, err);
        this._charCache.set(path, 'failed');
      }
    );
  }

  // Is the hunter BODY GLB loaded and ready to clone? (The weapon is optional — it
  // attaches if its own GLB is ready, else the soldier just holds no rifle yet.)
  _hunterModelReady() {
    const cm = this.characterModels && this.characterModels.hunter;
    if (!cm || !cm.model || !this._skeletonUtils) return false;
    const body = this._charCache.get('/assets/' + cm.model);
    return !!body && body !== 'failed' && body !== 'loading';
  }

  // Build one animated hunter instance: rig-safe clone of the body, sized to match the
  // hunter capsule (feet at the group origin), an AnimationMixer with the movement
  // clips resolved by suffix, and the rifle parented to the wrist bone. Returns a Group
  // whose userData.hunterCtl is the animation controller (mixer/actions/weapon), which
  // syncPlayers stores on the player entry and updateAnimations drives each frame.
  _buildHunterModel(cm) {
    const body = this._charCache.get('/assets/' + cm.model);
    if (!body || body === 'failed' || body === 'loading' || !this._skeletonUtils) return null;
    // Rig-safe clone — SkeletonUtils.clone rebinds SkinnedMesh to the cloned skeleton
    // (a plain THREE.Object3D.clone() shares/breaks the rig, freezing the animation).
    const inner = this._skeletonUtils.clone(body.scene);

    // Size + centre from the SKELETON, not the raw geometry. This GLB stores its skinned
    // mesh ~4 mm tall and inflates it to human size via a baked [100,100,100] scale on the
    // BONES, so Box3.setFromObject (the old approach, shipped broken twice) measured a
    // phantom and derived a garbage scale + off-origin pivot — the tiny/orbiting model.
    // sizeHunterRig traverses the bones for the true height/feet/centre, scales the WRAPPER
    // GROUP (so the bones and their skinned mesh actually scale), and rests the feet on the
    // group origin so the caller (baseY 0) plants the soldier where the networked capsule
    // is. Facing yaw (cm.yawOffsetDeg) is applied inside. Same code path as the size check.
    const { group } = sizeHunterRig(THREE, inner, cm);
    inner.traverse((o) => {
      if (o.isMesh) {
        o.castShadow = true;
        o.frustumCulled = false; // skinned bounds can under-report; don't cull mid-anim
      }
    });
    group.userData.baseY = 0; // feet on the ground; the caller adds jump-y
    group.userData.sizeChecked = false; // ?debug=1 tripwire fires once after the first frame

    // HELD TOOLS (B7): the rifle + the grenade + the prop-finder, all parented to the named
    // wrist bone. A remote hunter's model shows WHICH tool they've selected (host-synced `tool`)
    // — _applyHeldTool toggles which of the three is visible per snapshot. Before B7 only the
    // rifle was ever attached, so props saw a gun no matter what the hunter actually held.
    let weaponRoot = null;
    const heldTools = { rifle: null, finder: null, grenade: null };
    const wcfg = cm.weapon;
    // Tolerant bone lookup — GLTFLoader sanitizes "Wrist.R" to "WristR", so a strict name match
    // would silently drop the held item (see findBone). Shared with the check.
    const bone = wcfg && wcfg.attachBone ? findBone(inner, wcfg.attachBone) : null;
    const gripPos = (wcfg && wcfg.position) || {};
    if (wcfg && bone) {
      // --- Rifle: the real weapon GLB (unchanged sizing/orientation math) ---
      const wc = wcfg.model ? this._charCache.get('/assets/' + wcfg.model) : null;
      if (wc && wc !== 'failed' && wc !== 'loading') {
        weaponRoot = wc.scene.clone(true); // static mesh: plain clone is fine (no skin)
        const rot = wcfg.rotationDeg || {};
        const D = Math.PI / 180;
        weaponRoot.position.set(gripPos.x || 0, gripPos.y || 0, gripPos.z || 0);
        weaponRoot.rotation.set((rot.x || 0) * D, (rot.y || 0) * D, (rot.z || 0) * D);
        // WEAPON SIZING — normalise to a WORLD length, independent of the rig scale.
        // The wrist bone's world scale changed with the sizing fix (the group scale is
        // now bone-derived, not the old ~450× geometry factor) and it also carries the
        // armature's baked [100,100,100], so a bare config `scale` would blow the rifle
        // up or shrink it away. Measure the weapon's native size, read the bone's world
        // scale (group scale × armature × parent bones), and scale so the rifle's longest
        // axis lands at wcfg.worldLength metres (× the hot-tunable `scale` nudge). This is
        // correct-by-construction whatever the rig scale becomes. Shared by the grenade +
        // finder primitives below via _scaleHeldToBone.
        const worldLen = (wcfg.worldLength > 0 ? wcfg.worldLength : 0.7) * (wcfg.scale > 0 ? wcfg.scale : 1);
        this._scaleHeldToBone(weaponRoot, worldLen, bone, group);
        bone.add(weaponRoot);
        heldTools.rifle = weaponRoot;
      }
      // --- Grenade + prop-finder: cheap primitives matching the first-person viewmodels
      // (no new asset files). Same wrist bone, same grip anchor, scaled to a small in-hand
      // world size. Hidden until _applyHeldTool selects them from the host-synced tool. ---
      for (const toolId of ['finder', 'grenade']) {
        const root = this._buildHeldPrimitive(toolId);
        root.position.set(gripPos.x || 0, gripPos.y || 0, gripPos.z || 0);
        this._scaleHeldToBone(root, toolId === 'finder' ? 0.22 : 0.14, bone, group);
        bone.add(root);
        heldTools[toolId] = root;
      }
    } else if (wcfg && wcfg.model && !bone) {
      console.warn('[scene] hunter weapon bone not found:', wcfg.attachBone);
    }

    // AnimationMixer + the movement actions, clips matched by SUFFIX so the file's
    // 'CharacterArmature|' prefix is handled (see _resolveClip).
    const mixer = new THREE.AnimationMixer(inner);
    const clips = body.animations || [];
    const map = cm.clips || {};
    const actions = {};
    for (const stateName of ['idle', 'forward', 'backward', 'left', 'right']) {
      const clip = this._resolveClip(clips, map[stateName]);
      if (clip) actions[stateName] = mixer.clipAction(clip);
    }
    const a = cm.anim || {};
    const ctl = {
      mixer,
      actions,
      weaponRoot,
      heldTools,      // B7: { rifle, finder, grenade } meshes on the wrist bone (any may be null)
      heldTool: null, // the tool currently shown; set by _applyHeldTool (below + per snapshot)
      current: null,
      refSpeed: a.refSpeed > 0 ? a.refSpeed : 6,
      moveThreshold: a.moveThreshold >= 0 ? a.moveThreshold : 0.6,
      minTS: a.minTimeScale > 0 ? a.minTimeScale : 0.5,
      maxTS: a.maxTimeScale > 0 ? a.maxTimeScale : 1.8,
      fade: a.crossfadeSeconds >= 0 ? a.crossfadeSeconds : 0.15,
    };
    group.userData.hunterCtl = ctl;
    // Start on idle so a fresh hunter isn't frozen in bind pose for a beat.
    this._playHunterState(ctl, 'idle', 1);
    // B7: show the rifle by default (host `tool` starts on rifle); syncPlayers re-applies each
    // snapshot, so a hunter who joined already holding the finder/grenade updates immediately.
    this._applyHeldTool(ctl, 'rifle');
    return group;
  }

  // Find a clip by name, GUARDING the 'CharacterArmature|<clip>' prefix the GLB uses:
  // exact match, then any clip whose name ends in '|<suffix>', then any ending in the
  // suffix. Returns null when the clip is absent (caller degrades to idle).
  _resolveClip(clips, suffix) {
    if (!suffix || !clips || !clips.length) return null;
    return (
      clips.find((c) => c.name === suffix) ||
      clips.find((c) => c.name.endsWith('|' + suffix)) ||
      clips.find((c) => c.name.endsWith(suffix)) ||
      null
    );
  }

  // Crossfade a hunter to `stateName` at `timeScale`. Same clip already active -> just
  // update its speed. Missing clip (e.g. Run_Shoot absent) -> degrade to idle. Uses
  // fadeOut/fadeIn (~ctl.fade) so transitions don't pop.
  _playHunterState(ctl, stateName, timeScale) {
    const next = ctl.actions[stateName] || ctl.actions.idle;
    if (!next) return;
    if (ctl.current === next) {
      next.setEffectiveTimeScale(timeScale);
      return;
    }
    const prev = ctl.current;
    ctl.current = next;
    if (prev) prev.fadeOut(ctl.fade);
    next.reset().setEffectiveWeight(1).setEffectiveTimeScale(timeScale).fadeIn(ctl.fade).play();
  }

  // Advance every hunter's animation by dt and pick its clip from the DERIVED velocity
  // (computed once per snapshot in syncPlayers) relative to the player's facing:
  // stationary -> idle; else forward/back/left/right by the dominant axis, playback
  // speed scaled by actual speed. Called each render frame from main.js.
  updateAnimations(dt) {
    if (!(dt > 0)) return;
    for (const entry of this.players.values()) {
      const ctl = entry.hunterCtl;
      if (!ctl) continue;
      const v = entry.animVel || { x: 0, z: 0 };
      const speed = Math.hypot(v.x, v.z);
      if (speed < ctl.moveThreshold) {
        this._playHunterState(ctl, 'idle', 1);
      } else {
        const yaw = entry.target.yaw || 0;
        // forward = (-sin yaw, -cos yaw); right = (cos yaw, -sin yaw) — the shared
        // movement convention. Project velocity onto them to pick the clip.
        const fwd = v.x * -Math.sin(yaw) + v.z * -Math.cos(yaw);
        const rgt = v.x * Math.cos(yaw) + v.z * -Math.sin(yaw);
        let stateName;
        if (Math.abs(fwd) >= Math.abs(rgt)) stateName = fwd >= 0 ? 'forward' : 'backward';
        else stateName = rgt >= 0 ? 'right' : 'left';
        const ts = Math.min(ctl.maxTS, Math.max(ctl.minTS, speed / ctl.refSpeed));
        this._playHunterState(ctl, stateName, ts);
      }
      ctl.mixer.update(dt);

      // RUNTIME TRIPWIRE (?debug=1). After the first animated frame, measure the hunter's
      // REAL on-screen height from its bones (the same measurement the size check asserts)
      // and warn loudly if it's outside human range — so a sizing regression is caught in a
      // live browser instead of shipping silently a third time. Fires once per model.
      if (this._colliderDebug && entry.mesh && entry.mesh.userData && entry.mesh.userData.sizeChecked === false) {
        entry.mesh.userData.sizeChecked = true;
        const b = measureRigBones(THREE, entry.mesh);
        const h = b ? b.height : 0;
        if (!b || h < 1.2 || h > 2.5) {
          console.warn(
            `[scene] HUNTER MODEL SIZE TRIPWIRE: rendered bone height ${h.toFixed(3)} m is outside the human range 1.2–2.5 m` +
              (b ? ` (feet y=${b.footY.toFixed(2)})` : ' (no bones found)') +
              ' — the SWAT model is mis-sized. See shared/hunter-sizing.js + tools/check-hunter-model-size.mjs.'
          );
        }
      }
    }
  }

  // Show/hide the rifle on EVERY hunter (current + future), keeping the gun-holding
  // pose. SUPERSEDED by the per-hunter held-tool swap (B7, _applyHeldTool) which is what
  // syncPlayers drives now; kept only as a manual override and unused in normal play.
  setWeaponVisible(visible) {
    this._weaponVisible = !!visible;
    for (const entry of this.players.values()) {
      const ctl = entry.hunterCtl;
      if (ctl && ctl.weaponRoot) ctl.weaponRoot.visible = this._weaponVisible;
    }
  }

  // ---- HELD-TOOL VISIBILITY (B7): show WHICH tool a remote hunter has selected -----------
  // Other players should see the grenade / prop-finder in the hunter's hand — not always a gun.
  // Three held meshes are pre-built on the wrist bone in _buildHunterModel; these helpers build
  // the cheap grenade/finder primitives, size them to the bone, and toggle which is visible.

  // Build a small held mesh for the grenade or prop-finder, matching the look of the
  // first-person viewmodel (see _buildViewModel) so the hand item reads the same in both views.
  // Native-sized (~real proportions); _scaleHeldToBone normalises it into the hand afterwards.
  _buildHeldPrimitive(toolId) {
    const g = new THREE.Group();
    if (toolId === 'finder') {
      // PROP FINDER — the blue handheld device (matches the first-person 0.3 m box).
      const box = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.3, 0.3), new THREE.MeshLambertMaterial({ color: 0x49b6ff }));
      g.add(box);
    } else {
      // GRENADE — a dark-green sphere with a lighter cap (matches the first-person viewmodel).
      const body = new THREE.Mesh(new THREE.SphereGeometry(0.11, 12, 10), new THREE.MeshLambertMaterial({ color: 0x3c5a34 }));
      const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 0.05, 8), new THREE.MeshLambertMaterial({ color: 0x9aa0aa }));
      cap.position.set(0, 0.12, 0);
      g.add(body, cap);
    }
    // ANTI-FLICKER (defence in depth): the whole hunter model already routes through
    // preparePlayerModel (culling OFF) via meshForPlayer, but flag these hand-built meshes too
    // so a held tool can never blink at the screen edge like the strobe bug we fixed.
    g.traverse((o) => { if (o.isMesh) o.frustumCulled = false; });
    return g;
  }

  // Scale a held mesh so its longest axis lands at `worldLen` METRES in the wrist bone's frame,
  // independent of the rig scale. Same normalisation the rifle uses (see _buildHunterModel):
  // the bone carries the sized group scale × the armature's baked [100,100,100], so a bare local
  // scale would blow the item up or shrink it away. Also enables shadows + disables culling.
  _scaleHeldToBone(root, worldLen, bone, group) {
    group.updateMatrixWorld(true); // resolve bone world scale under the sized group
    const bs = new THREE.Vector3();
    bone.getWorldScale(bs);
    const boneScale = (Math.abs(bs.x) + Math.abs(bs.y) + Math.abs(bs.z)) / 3 || 1;
    const size = new THREE.Vector3();
    new THREE.Box3().setFromObject(root).getSize(size); // native (local scale still 1)
    const nativeLen = Math.max(size.x, size.y, size.z) || 1;
    root.scale.setScalar(worldLen / (boneScale * nativeLen));
    root.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.frustumCulled = false; } });
  }

  // Show ONLY the mesh for `toolId` on this hunter's wrist (host-synced `tool`; unknown/missing
  // → rifle). Per-hunter — different hunters can hold different tools at once. Cheap: it only
  // toggles .visible on the pre-built held meshes (no rebuild). Called from _buildHunterModel
  // (initial) and every snapshot in syncPlayers (a tool switch / a mid-game joiner's tool).
  _applyHeldTool(ctl, toolId) {
    if (!ctl || !ctl.heldTools) return;
    const id = ctl.heldTools[toolId] ? toolId : 'rifle';
    if (ctl.heldTool === id) return;
    ctl.heldTool = id;
    for (const k in ctl.heldTools) {
      const m = ctl.heldTools[k];
      if (m) m.visible = k === id;
    }
  }

  // ---- HUNTER-TOOLS v1: aim, first-person viewmodel, tracers -----------------

  // The camera-forward aim direction through the fixed screen-centre reticle — the SAME
  // ray aimedDisguiseTarget uses for the disguise pick. main.js sends this to the host on
  // fire; the host re-casts the shot from its authoritative eye along this direction.
  // Returns { x, y, z } (unit) or null before the camera exists.
  aimDirection() {
    if (!this.camera) return null;
    this.camera.updateMatrixWorld();
    this._raycaster.setFromCamera(this._aimNDC || SCREEN_CENTER, this.camera);
    const d = this._raycaster.ray.direction;
    if (!d) return null;
    return { x: d.x, y: d.y, z: d.z };
  }

  // Show the local hunter's held tool as a first-person VIEWMODEL parented to the camera:
  // 'rifle' (the assault rifle), 'finder' (a ~1 ft box — Prop Finder, does nothing), or
  // null (props / dead / no tool → hide it). This is how tool switching is visible to the
  // shooter themselves (a first-person hunter draws no full body). Cheap rebuild on change;
  // no-op when unchanged. NOT networked in v1 (held-tool sync is deferred) — purely local.
  setViewModel(toolId) {
    const id = toolId || null;
    if (this._viewModelTool === id) return;
    this._viewModelTool = id;
    if (this._viewModel) {
      this.camera.remove(this._viewModel);
      this._viewModel = null;
    }
    if (!id) return;
    const g = this._buildViewModel(id);
    if (g) { this.camera.add(g); this._viewModel = g; }
  }

  _buildViewModel(toolId) {
    const g = new THREE.Group();
    if (toolId === 'rifle') {
      // Prefer the real rifle GLB (already loaded for the SWAT soldier); fall back to a
      // primitive barrel so a first-person hunter always sees SOMETHING in hand.
      const wcfg = this.characterModels && this.characterModels.hunter && this.characterModels.hunter.weapon;
      const tmpl = wcfg && wcfg.model ? this._charCache.get('/assets/' + wcfg.model) : null;
      if (tmpl && tmpl !== 'failed' && tmpl !== 'loading' && tmpl.scene) {
        const m = tmpl.scene.clone(true);
        const size = new THREE.Vector3();
        new THREE.Box3().setFromObject(m).getSize(size);
        const nativeLen = Math.max(size.x, size.y, size.z) || 1;
        m.scale.setScalar(0.5 / nativeLen); // ~0.5 m held rifle
        m.rotation.set(0, Math.PI / 2, 0); // roughly point the barrel forward (−Z)
        m.traverse((o) => { if (o.isMesh) { o.castShadow = false; o.frustumCulled = false; } });
        g.add(m);
      } else {
        const barrel = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.06, 0.5), new THREE.MeshLambertMaterial({ color: 0x24242c }));
        barrel.position.set(0, 0, -0.25);
        g.add(barrel);
        g.userData.rifleFallback = true; // upgrade to the real GLB once it finishes loading
      }
    } else if (toolId === 'finder') {
      // PROP FINDER: a ~1 ft (0.3 m) handheld device. Activating it (left-click / fire button)
      // forces every prop inside the AOE cylinder to taunt — see main.js tryFinder / scene.updateFinderZone.
      const box = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.3, 0.3), new THREE.MeshLambertMaterial({ color: 0x49b6ff }));
      g.add(box);
    } else if (toolId === 'grenade') {
      // HUNTER GRENADES: a small handheld grenade (a dark-green sphere with a lighter cap). Throwing
      // it (left-click / fire button) raycasts from the aim point and explodes INSTANTLY at the first
      // hit — see main.js tryGrenade / referee.applyGrenade. Purely cosmetic (no cooldown to show).
      const body = new THREE.Mesh(new THREE.SphereGeometry(0.11, 12, 10), new THREE.MeshLambertMaterial({ color: 0x3c5a34 }));
      const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 0.05, 8), new THREE.MeshLambertMaterial({ color: 0x9aa0aa }));
      cap.position.set(0, 0.12, 0);
      g.add(body, cap);
    } else {
      return null;
    }
    g.position.set(0.32, -0.3, -0.7); // held down-and-right in front of the camera
    g.traverse((o) => { if (o.isMesh) o.frustumCulled = false; });
    return g;
  }

  // PROP FINDER: draw / update the translucent AOE cylinder centred on the local hunter while the
  // finder tool is selected. `opts`:
  //   visible : show it at all (a live hunter holding the finder)
  //   ready   : true => GREEN @ 40% opacity (activatable); false => GREY @ 20% (cooling down)
  //   radius  : AOE radius in metres (rules.finderRadius — hot-tunable)
  //   pos     : {x,y,z} the hunter's displayed foot position; the cylinder follows it each frame
  // The cylinder is EFFECTIVELY INFINITE in height — a very tall fixed height, clamped so it reads
  // as floor-to-ceiling without z-fighting the ground/roof. Built once, cheaply toggled/recoloured.
  updateFinderZone(opts = {}) {
    if (!this.scene) return;
    const visible = !!opts.visible;
    if (!visible) {
      if (this._finderZone) this._finderZone.visible = false;
      return;
    }
    const radius = opts.radius > 0 ? opts.radius : 8;
    // Rebuild if missing or the tunable radius changed (VRmike adjusts it in testing).
    if (!this._finderZone || Math.abs(this._finderZoneRadius - radius) > 1e-3) {
      if (this._finderZone && this._finderZone.parent) this._finderZone.parent.remove(this._finderZone);
      const H = 200; // "infinite" height — tall enough to read as floor-to-ceiling on any map
      const geo = new THREE.CylinderGeometry(radius, radius, H, 40, 1, true); // open-ended tube
      const mat = new THREE.MeshBasicMaterial({
        color: 0x39ff88, transparent: true, opacity: 0.4,
        side: THREE.DoubleSide, depthWrite: false,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.renderOrder = 3; // draw over the world so the translucency reads cleanly
      mesh.frustumCulled = false;
      this.scene.add(mesh);
      this._finderZone = mesh;
      this._finderZoneRadius = radius;
    }
    const z = this._finderZone;
    z.visible = true;
    const ready = opts.ready !== false;
    z.material.color.setHex(ready ? 0x39ff88 : 0x9aa0aa); // green ready / grey cooling
    z.material.opacity = ready ? 0.4 : 0.2;
    const p = opts.pos || { x: 0, y: 0, z: 0 };
    z.position.set(p.x, p.y || 0, p.z); // cylinder is centred on its own height, so it spans ±H/2
  }

  // Play a short NON-positional UI sound (the prop-finder denied buzz) through THREE's shared audio
  // context/listener — a flat 2D blip for the local player, not a world-positioned taunt. No-op
  // (silent, never throws) if audio is unavailable. See main.js playFinderDenied.
  playUiSound(buffer, volume = 0.5) {
    if (!buffer) return;
    const listener = this._ensureAudioListener();
    if (!listener || !THREE.Audio) return;
    try {
      const a = new THREE.Audio(listener);
      a.setBuffer(buffer);
      a.setLoop(false);
      a.setVolume(volume);
      a.play();
    } catch { /* audio blocked/unavailable → silent */ }
  }

  // COMBAT SFX (2026-07-18, VRmike B5): play `buffer` as a fire-and-forget 3D POSITIONAL one-shot at
  // world point `pos` ({x,y,z}) — the gunshot at the muzzle, the grenade at the blast centre, the prop
  // ouch at the prop. Reuses the SAME positional path as taunts: THREE.PositionalAudio wired to the one
  // shared AudioListener (→ master limiter → output), inverse-square distance falloff tuned to the map,
  // and HRTF binaural panning. Unlike a taunt this emitter sits at a FIXED point (short clips; nothing
  // to follow) and self-disposes when it finishes (updateTauntEmitters reaps it). `opts`:
  //   volume  — per-source trim (0..1); keep modest, the limiter is a safety net not the mixer.
  //   rate    — playbackRate (prop-ouch pitch-by-size; default 1.0 = unchanged pitch).
  //   mapSize — map width for the distance-falloff refDistance (same math as playTaunt).
  // No-op (silent, never throws) if audio is unavailable — audio must never break the game.
  playPositionalSound(pos, buffer, opts = {}) {
    if (!buffer || !pos) return;
    const listener = this._ensureAudioListener();
    if (!listener || !THREE.PositionalAudio) return;
    let sound;
    try {
      sound = new THREE.PositionalAudio(listener);
      sound.setBuffer(buffer);
      // Inverse-square falloff, tuned to the map — IDENTICAL model to playTaunt (see the long note
      // there): exponential distanceModel + rolloffFactor 2, refDistance solved so the sound lands at
      // COMBAT_FALLOFF_TARGET of full volume one map width away. Two knobs, one-line retunes.
      const COMBAT_FALLOFF_TARGET = 0.03; // gain fraction at ONE MAP WIDTH away — retune knob
      const COMBAT_FALLOFF_EXP = 2;       // distance exponent; 2 = true inverse-square (rolloffFactor)
      const size = opts.mapSize || (this._lastMap && this._lastMap.size) || 36;
      sound.setDistanceModel('exponential');
      sound.setRefDistance(Math.max(2, size * Math.pow(COMBAT_FALLOFF_TARGET, 1 / COMBAT_FALLOFF_EXP)));
      sound.setRolloffFactor(COMBAT_FALLOFF_EXP);
      // Per-source trim: modest so several combat sounds at once stay under the master limiter.
      sound.setVolume(Number.isFinite(opts.volume) ? opts.volume : 0.7);
      // PROP OUCH pitch-by-size: Web Audio playbackRate is the cheap correct pitch lever. Default 1.0
      // leaves the gunshot/grenade/finder-ping pitch untouched.
      if (Number.isFinite(opts.rate) && opts.rate > 0 && sound.setPlaybackRate) sound.setPlaybackRate(opts.rate);
      sound.setLoop(false);
    } catch { return; }
    // HRTF binaural panning on the underlying PannerNode — its OWN guarded try/catch, exactly like
    // playTaunt: if unavailable we keep THREE's default equalpower pan and still play the sound.
    try {
      const panner = sound.panner;
      if (panner) panner.panningModel = TAUNT_PANNING.model || TAUNT_PANNING.fallback;
    } catch { /* keep default panning — never break audio over a panner tweak */ }
    const obj = new THREE.Object3D();
    obj.add(sound);
    obj.position.set(pos.x, pos.y || 0, pos.z);
    this.scene.add(obj);
    const durMs = ((buffer.duration || 1) / (Number.isFinite(opts.rate) && opts.rate > 0 ? opts.rate : 1)) * 1000;
    const nowT = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    this._oneShots.push({ obj, sound, endsAt: nowT + durMs + 250 });
    try { sound.play(); } catch { /* autoplay blocked until unlock — reaped by endsAt anyway */ }
  }

  _disposeOneShot(rec) {
    try { if (rec.sound && rec.sound.isPlaying) rec.sound.stop(); } catch { /* ignore */ }
    try { if (rec.sound && rec.sound.disconnect) rec.sound.disconnect(); } catch { /* ignore */ }
    if (rec.obj && rec.obj.parent) rec.obj.parent.remove(rec.obj);
  }

  _stopAllOneShots() {
    if (!this._oneShots) { this._oneShots = []; return; }
    for (const rec of this._oneShots) this._disposeOneShot(rec);
    this._oneShots = [];
  }

  // Spawn a muzzle flash at (a*) and a tracer round from (a*) to the impact point (b*),
  // visible to EVERYONE (driven by the host's 'shot' event). Short-lived; updateEffects
  // fades + removes them. Reuses shared geometries so a burst of fire allocates little.
  spawnTracer(ax, ay, az, bx, by, bz) {
    if (!this.scene) return;
    const a = new THREE.Vector3(ax, ay, az);
    const b = new THREE.Vector3(bx, by, bz);
    const diff = b.clone().sub(a);
    const len = diff.length() || 0.01;
    const geo = this._tracerGeo || (this._tracerGeo = new THREE.CylinderGeometry(0.02, 0.02, 1, 6));
    const tracer = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: 0xfff2a0, transparent: true, opacity: 0.9, depthWrite: false }));
    tracer.position.copy(a).addScaledVector(diff, 0.5);
    tracer.quaternion.setFromUnitVectors(UP_Y, diff.clone().normalize());
    tracer.scale.set(1, len, 1);
    this.scene.add(tracer);
    const fgeo = this._flashGeo || (this._flashGeo = new THREE.SphereGeometry(0.14, 8, 6));
    const flash = new THREE.Mesh(fgeo, new THREE.MeshBasicMaterial({ color: 0xffe08a, transparent: true, opacity: 1, depthWrite: false }));
    flash.position.set(ax, ay, az);
    this.scene.add(flash);
    this._effects.push({ tracer, flash, life: 0.12, max: 0.12 });
  }

  // HUNTER GRENADES: a short-lived 3D explosion at the host-computed blast centre (x,y,z), visible
  // to EVERYONE (driven by the host's kind:'grenade' event). A bright core plus an expanding shell
  // that grows to roughly the blast's outer radius and fades. updateEffects animates + retires it.
  spawnExplosion(x, y, z) {
    if (!this.scene || x == null) return;
    // Read the blast radius from the shared rules (main.js sets scene.rules); fall back to 3 m
    // (= the shipping fullDamageRadius 1 + falloffDistance 2). Authored as the sum, never hardcoded.
    const g = this.rules && this.rules.grenade;
    const radius = g && Number.isFinite(g.fullDamageRadius) && Number.isFinite(g.falloffDistance)
      ? g.fullDamageRadius + g.falloffDistance : 3;
    const cgeo = this._blastCoreGeo || (this._blastCoreGeo = new THREE.SphereGeometry(1, 16, 12));
    const core = new THREE.Mesh(cgeo, new THREE.MeshBasicMaterial({ color: 0xfff1c2, transparent: true, opacity: 1, depthWrite: false }));
    core.position.set(x, y, z);
    core.scale.setScalar(radius * 0.35);
    const ring = new THREE.Mesh(cgeo, new THREE.MeshBasicMaterial({ color: 0xff7a2e, transparent: true, opacity: 0.7, depthWrite: false }));
    ring.position.set(x, y, z);
    ring.scale.setScalar(radius * 0.5);
    this.scene.add(core, ring);
    this._blasts.push({ core, ring, life: 0.5, max: 0.5, radius });
  }

  // HUNTER GRENADES: intensity (0..1) of the local screen flash for a blast at (x,y,z), by distance
  // from the camera — full up close, zero past ~4× the blast radius. main.js passes it to
  // ui.flashScreen so a distant explosion doesn't flash your screen. Never throws.
  blastFlashAt(x, y, z) {
    if (!this.camera || x == null) return 0;
    const g = this.rules && this.rules.grenade;
    const radius = g && Number.isFinite(g.fullDamageRadius) && Number.isFinite(g.falloffDistance)
      ? g.fullDamageRadius + g.falloffDistance : 3;
    const c = this.camera.position;
    const d = Math.hypot(c.x - x, c.y - y, c.z - z);
    const reach = radius * 4; // beyond this the blast is too far to flash the screen
    if (d >= reach) return 0;
    return Math.max(0, Math.min(1, 1 - d / reach));
  }

  // Fade + retire active shot effects. Called each frame from main.js (like updateAnimations).
  updateEffects(dt) {
    // Upgrade a first-person rifle viewmodel from its primitive fallback to the real GLB
    // once the (async) weapon model has finished loading. Cheap: one cache lookup/frame.
    if (this._viewModel && this._viewModelTool === 'rifle' && this._viewModel.userData.rifleFallback) {
      const wcfg = this.characterModels && this.characterModels.hunter && this.characterModels.hunter.weapon;
      const tmpl = wcfg && wcfg.model ? this._charCache.get('/assets/' + wcfg.model) : null;
      if (tmpl && tmpl !== 'failed' && tmpl !== 'loading' && tmpl.scene) {
        this._viewModelTool = null; // force a rebuild against the now-loaded GLB
        this.setViewModel('rifle');
      }
    }
    // HUNTER GRENADES: grow + fade each active explosion, then retire it (dispose its materials).
    if (this._blasts && this._blasts.length) {
      const keptBlasts = [];
      for (const b of this._blasts) {
        b.life -= dt;
        const t = b.life > 0 ? b.life / b.max : 0; // 1 -> 0 over the lifetime
        const grow = 1 - t; // 0 -> 1
        b.core.scale.setScalar(b.radius * (0.35 + grow * 0.35));
        b.core.material.opacity = t; // core fades fastest
        b.ring.scale.setScalar(b.radius * (0.5 + grow * 0.9));
        b.ring.material.opacity = 0.7 * t;
        if (b.life > 0) {
          keptBlasts.push(b);
        } else {
          this.scene.remove(b.core);
          this.scene.remove(b.ring);
          b.core.material.dispose();
          b.ring.material.dispose();
        }
      }
      this._blasts = keptBlasts;
    }
    if (!this._effects || !this._effects.length) return;
    const keep = [];
    for (const e of this._effects) {
      e.life -= dt;
      const k = e.life > 0 ? e.life / e.max : 0;
      e.tracer.material.opacity = 0.9 * k;
      e.flash.material.opacity = k;
      e.flash.scale.setScalar(1 + (1 - k) * 1.8);
      if (e.life > 0) {
        keep.push(e);
      } else {
        this.scene.remove(e.tracer);
        this.scene.remove(e.flash);
        e.tracer.material.dispose();
        e.flash.material.dispose();
      }
    }
    this._effects = keep;
  }

  // ---- audio taunts (3D positional) -----------------------------------------
  // Lazily create the AudioListener on the camera (the Web Audio listener that gives taunts
  // their stereo direction). Returns null if THREE's audio classes are unavailable. Re-parents
  // after a scene.clear() (which detaches then re-adds the camera in buildWorld).
  _ensureAudioListener() {
    if (!THREE.AudioListener) return null;
    if (!this._audioListener) this._audioListener = new THREE.AudioListener();
    if (this._audioListener.parent !== this.camera) this.camera.add(this._audioListener);
    this._ensureMasterLimiter(); // splice the master limiter into the listener's output (once)
    return this._audioListener;
  }

  // MASTER AUDIO LIMITER: route the listener's summed output through a headroom trim + near-brickwall
  // compressor so several overlapping loud sounds (taunts + finder buzz + future audio) can't add
  // past 0dBFS and clip. Idempotent (splices once); fail-silent — on any failure THREE's default
  // direct gain→destination connection stays intact so audio still plays, just uncapped. The chain
  // lives on the AudioContext (not the scene graph), so it survives buildWorld's scene.clear().
  _ensureMasterLimiter() {
    if (this._masterLimiter) return; // already spliced
    const chain = installMasterLimiter(this._audioListener);
    if (chain) { this._masterPreGain = chain.preGain; this._masterLimiter = chain.limiter; }
  }

  // THREE's shared Web Audio context (for decoding clips + the iOS unlock). null if unavailable.
  audioContext() {
    try { return THREE.AudioContext ? THREE.AudioContext.getContext() : null; } catch { return null; }
  }

  // Resume the audio context inside a user gesture (iOS keeps audio suspended until then). Called
  // from the taunt open/play gestures (main.js) — the one tap/click/keypress iOS gives us.
  unlockAudio() {
    const ctx = this.audioContext();
    try { if (ctx && ctx.state === 'suspended') ctx.resume(); } catch { /* best-effort */ }
  }

  // Fetch + decode an audio file to an AudioBuffer via THREE.AudioLoader (which decodes through
  // THREE's shared AudioContext and handles Safari's callback-style decodeAudioData). Returns a
  // Promise<AudioBuffer|null> — resolves null (never rejects) on any failure so a missing/bad clip
  // degrades to silence. Used by the lazy taunt loader (js/taunts.js). Ensures the listener/context
  // exist first so the decode has a context to run in.
  loadAudioBuffer(url) {
    return new Promise((resolve) => {
      try {
        if (!THREE.AudioLoader) { resolve(null); return; }
        this._ensureAudioListener(); // creates THREE's shared AudioContext if needed
        new THREE.AudioLoader().load(url, (buf) => resolve(buf || null), undefined, () => resolve(null));
      } catch { resolve(null); }
    });
  }

  // Stop + dispose EVERY active taunt emitter (public wrapper). Called by main.js when leaving a
  // match so no taunt bleeds past the round/menu teardown.
  clearAllTaunts() {
    this._stopAllTaunts();
  }

  // Play taunt `buffer` as 3D positional audio at player `playerId`'s live position. CUT-OFF
  // RULE: a taunt already playing for this SAME player is stopped first (one voice per prop);
  // different players' taunts keep their own emitters and overlap freely. The emitter follows the
  // player each frame (updateTauntEmitters). `opts.mapSize` tunes distance falloff to the map.
  // No-op (silent, never throws) if audio is unavailable — audio must never break the game.
  playTaunt(playerId, buffer, opts = {}) {
    if (!buffer) return;
    const listener = this._ensureAudioListener();
    if (!listener || !THREE.PositionalAudio) return;
    this.stopTaunt(playerId); // cut off this player's previous taunt (one voice per prop)
    let sound;
    try {
      sound = new THREE.PositionalAudio(listener);
      sound.setBuffer(buffer);
      // INVERSE-SQUARE falloff, tuned to the map (restaurant ≈ 36 units) (Jie, 2026-07-18).
      // Web Audio has no literal "inverse-square" distanceModel, but the EXPONENTIAL model with a
      // rolloffFactor of 2 IS exactly inverse-square: gain = (d / refDistance)^-rolloff. We pick
      // refDistance so a taunt one full MAP WIDTH away lands at TAUNT_FALLOFF_TARGET of full volume:
      //   (size / ref)^-EXP = target  →  ref = size * target^(1/EXP) = size * √0.03 ≈ 0.1732 * size
      // (≈6.2 units on the 36-unit map). Full volume inside that radius, inverse-square beyond,
      // exactly 3% at one map width. The two constants are the tuning knobs — one-line retunes after
      // playtesting. maxDistance is deliberately NOT set: non-linear distance models IGNORE it, so
      // leaving it in would only mislead the next reader.
      // TRADEOFF (intentional, not a bug): inverse-square never reaches true zero — a taunt anywhere
      // on the map stays faintly audible (~3%) instead of going fully silent like the old linear
      // model. That's the realism Jie asked to try. See notes/audio-taunts.md.
      const TAUNT_FALLOFF_TARGET = 0.03; // gain fraction at ONE MAP WIDTH away — retune knob
      const TAUNT_FALLOFF_EXP = 2;       // distance exponent; 2 = true inverse-square (rolloffFactor)
      const size = opts.mapSize || (this._lastMap && this._lastMap.size) || 36;
      sound.setDistanceModel('exponential');
      sound.setRefDistance(Math.max(2, size * Math.pow(TAUNT_FALLOFF_TARGET, 1 / TAUNT_FALLOFF_EXP)));
      sound.setRolloffFactor(TAUNT_FALLOFF_EXP);
      // Per-source trim: emitters otherwise play at full 1.0 inside refDistance, so several props
      // taunting near you stack toward the ceiling. A modest 0.85 keeps each taunt loud while
      // leaving the master limiter as a safety net rather than the mixer. See notes/audio-limiter.md.
      sound.setVolume(0.85);
      sound.setLoop(false);
    } catch { return; }
    // HRTF binaural panning on the underlying Web Audio PannerNode (THREE.PositionalAudio exposes
    // it as `.panner`). Its OWN guarded try/catch, OUTSIDE the create block above: if `.panner` is
    // unavailable or the assignment fails for any reason we silently keep THREE's default equalpower
    // pan and still play the taunt — audio must never throw (house rule). `model || fallback` means
    // an empty knob degrades to equalpower rather than an invalid (silently-ignored) value.
    try {
      const panner = sound.panner;
      if (panner) panner.panningModel = TAUNT_PANNING.model || TAUNT_PANNING.fallback;
    } catch { /* keep default panning — never break audio over a panner tweak */ }
    const obj = new THREE.Object3D();
    obj.add(sound);
    this.scene.add(obj);
    // Seed the emitter at the player's current position so the very first audio frame pans right.
    const p = this._playerWorldPos(playerId);
    if (p) obj.position.set(p.x, (p.y || 0) + 1.0, p.z);
    const durMs = (buffer.duration || 1) * 1000;
    const nowT = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    this._tauntEmitters.set(playerId, { obj, sound, endsAt: nowT + durMs + 250 });
    try { sound.play(); } catch { /* autoplay blocked until unlock — emitter still cleans up */ }
  }

  // Stop + dispose the taunt emitter for one player (immediate kill for the STOP button, and the
  // cut-off path). Safe to call when nothing is playing.
  stopTaunt(playerId) {
    const rec = this._tauntEmitters.get(playerId);
    if (!rec) return;
    this._tauntEmitters.delete(playerId);
    this._disposeTauntEmitter(rec);
  }

  _disposeTauntEmitter(rec) {
    try { if (rec.sound && rec.sound.isPlaying) rec.sound.stop(); } catch { /* ignore */ }
    try { if (rec.sound && rec.sound.disconnect) rec.sound.disconnect(); } catch { /* ignore */ }
    if (rec.obj && rec.obj.parent) rec.obj.parent.remove(rec.obj);
  }

  _stopAllTaunts() {
    for (const rec of this._tauntEmitters.values()) this._disposeTauntEmitter(rec);
    this._tauntEmitters.clear();
  }

  // Live world position of a player (self or remote) from their rendered mesh, or null if not
  // yet built. The taunt emitter tracks this so the sound follows a moving prop.
  _playerWorldPos(playerId) {
    if (playerId === this.selfId && this.selfMesh) return this.selfMesh.position;
    const entry = this.players.get(playerId);
    if (entry && entry.mesh) return entry.mesh.position;
    return null;
  }

  // Per-frame: keep each active taunt emitter glued to its player's current position and retire
  // finished ones. Called from the render loop (after mesh positions update, before render).
  updateTauntEmitters() {
    const nowT = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    // COMBAT SFX: reap finished positional one-shots (fixed-point emitters — nothing to reposition).
    if (this._oneShots && this._oneShots.length) {
      this._oneShots = this._oneShots.filter((rec) => {
        const done = (!rec.sound || !rec.sound.isPlaying) && nowT > rec.endsAt;
        if (done) { this._disposeOneShot(rec); return false; }
        return true;
      });
    }
    if (!this._tauntEmitters.size) return;
    for (const [id, rec] of this._tauntEmitters) {
      const finished = (!rec.sound || !rec.sound.isPlaying) && nowT > rec.endsAt;
      if (finished) { this._disposeTauntEmitter(rec); this._tauntEmitters.delete(id); continue; }
      const p = this._playerWorldPos(id);
      if (p) rec.obj.position.set(p.x, (p.y || 0) + 1.0, p.z);
    }
  }

  // ---- collider debug overlay (?debug=1) ------------------------------------
  // A reusable wireframe box (unit cube edges) scaled/placed per collider. Colour codes
  // the collider KIND so a mismatch reads at a glance.
  _wireBox(w, h, d, color) {
    const geo = new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1));
    const mat = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.85 });
    const box = new THREE.LineSegments(geo, mat);
    box.scale.set(Math.max(w, 1e-3), Math.max(h, 1e-3), Math.max(d, 1e-3));
    box.renderOrder = 998;
    box.frustumCulled = false;
    return box;
  }

  // Parent a prop's collider outline (yellow) to its container, centred on the body
  // centre (== container origin), so it moves/rotates with the shoved prop. Returns the
  // wire so the live collider-view toggle can track + remove it.
  _addPropColliderWire(container, c) {
    if (!c) return null;
    const he = halfExtentsFor(c);
    const w = this._wireBox(he.hx * 2, he.hy * 2, he.hz * 2, 0xffd23f);
    container.add(w);
    return w;
  }

  // Draw the static world colliders (ground grey, boundary walls red, static fixtures
  // cyan) from shared/bounds.js — the SAME boxes physics.js builds and the guard checks.
  // Stored on this._colliderStaticGroup so the live toggle can remove it cleanly.
  _buildStaticColliderDebug(map, catalog) {
    const group = new THREE.Group();
    const boxes = worldColliderBoxes(map, catalog, this.rules || {}, this._removedFixtures);
    for (const b of boxes) {
      const color = b.kind === 'ground' ? 0x555555 : b.kind === 'wall' ? 0xff5a5a : 0x4ad9ff;
      const w = this._wireBox(b.hx * 2, b.hy * 2, b.hz * 2, color);
      w.position.set(b.cx, b.cy, b.cz);
      w.rotation.y = b.rot || 0;
      group.add(w);
    }
    this.scene.add(group); // dropped by the next buildWorld's scene.clear()
    this._colliderStaticGroup = group;
    return group;
  }

  // ---- LIVE collider view toggle (debug menu) -------------------------------
  // Show/hide ALL collider wireframes at runtime (props, players, fixtures, architecture),
  // reusing the same builders + shared collider-size source as the ?debug=1 overlay. Clean
  // build/teardown so it can be flipped any number of times mid-match.
  setColliderView(on) {
    this._colliderViewOn = !!on;
    this._clearColliderView(); // idempotent — drop any existing wires first
    if (this._colliderViewOn) this._buildColliderView();
  }

  _buildColliderView() {
    if (!this._lastMap) return; // no world yet — buildWorld will call us when one exists
    // Static world (ground/walls) + static fixtures, from the shared source.
    this._buildStaticColliderDebug(this._lastMap, this._lastCatalog);
    // Every dynamic/disguise prop: collider parented to its container so it tracks shoves.
    if (this.propMeshes) {
      for (const rec of this.propMeshes.values()) {
        if (rec.isStatic) continue; // static fixtures are covered by the static group above
        const w = this._addPropColliderWire(rec.container, this._lastCatalog[rec.type]);
        if (w) this._colliderWires.push({ obj: w, parent: rec.container });
      }
    }
    // Every player CAPSULE (movement collider, green) + SHOT hitbox (disguise sensor, orange),
    // sized from the same collider sources physics uses (halfExtentsFor / _capsuleDimsFor).
    for (const entry of this.players.values()) {
      this._addPlayerColliderWire(entry);
      this._addPlayerShotWire(entry);
    }
    // The LOCAL player too (bug fix: only remote players used to show). selfMesh may not exist
    // yet on the first build — the next _syncSelf re-adds it while _colliderViewOn is true.
    if (this.selfMesh) this._addSelfColliderWires();
  }

  _clearColliderView() {
    if (this._colliderStaticGroup) { this.scene.remove(this._colliderStaticGroup); this._colliderStaticGroup = null; }
    for (const { obj, parent } of this._colliderWires) { if (parent) parent.remove(obj); }
    this._colliderWires = [];
    for (const entry of this.players.values()) {
      if (entry.colliderWire && entry.mesh) entry.mesh.remove(entry.colliderWire);
      if (entry.shotWire && entry.mesh) entry.mesh.remove(entry.shotWire);
      if (entry) { entry.colliderWire = null; entry.shotWire = null; }
    }
    // Local player's own wires (children of selfMesh).
    if (this._selfWireEntry) {
      const e = this._selfWireEntry;
      if (e.colliderWire && e.mesh) e.mesh.remove(e.colliderWire);
      if (e.shotWire && e.mesh) e.mesh.remove(e.shotWire);
      e.colliderWire = null; e.shotWire = null;
    }
  }

  // Player capsule collider wire (green), parented to the player mesh so it tracks them.
  // Sized from the SAME collider source physics bakes: base capsule (rules.playerRadius/
  // playerHalfHeight), grown to the disguise footprint girth (capped at
  // disguiseColliderMaxRadius) exactly like PhysicsWorld._capsuleDimsFor. New geometry —
  // player capsules weren't drawn by the old overlay.
  _addPlayerColliderWire(entry) {
    if (!entry || !entry.mesh || entry.colliderWire) return;
    const rules = this.rules || {};
    const baseR = rules.playerRadius != null ? rules.playerRadius : 0.4;
    const halfCyl = rules.playerHalfHeight != null ? rules.playerHalfHeight : 0.5;
    const centerY = baseR + halfCyl; // capsule centre above the foot
    let r = baseR;
    const type = entry.disguiseType;
    if (type && this.catalog && this.catalog[type]) {
      const he = halfExtentsFor(this.catalog[type]);
      const cap = rules.disguiseColliderMaxRadius != null ? rules.disguiseColliderMaxRadius : 0.55;
      r = Math.min(cap, Math.max(baseR, Math.min(he.hx, he.hz)));
    }
    const w = this._wireBox(r * 2, 2 * (baseR + halfCyl), r * 2, 0x7be38b);
    // Re-centre on the capsule centre relative to the mesh origin (mesh origin sits baseY
    // above the foot; the capsule centre is r+halfCyl above the foot).
    w.position.y = centerY - (entry.mesh.userData.baseY || 0);
    entry.mesh.add(w);
    entry.colliderWire = w;
  }

  // SHOT-hitbox wire (ORANGE, distinct from the green movement-capsule wire) — draws the exact
  // shape the authoritative shot raycast tests: a disguised player's disguise-shaped SENSOR
  // (physics.setShotCollider builds it from the SAME halfExtentsFor footprint), or a capsule-
  // matching box when undisguised. Parented to the player mesh so it tracks position AND the
  // disguise's yaw (the mesh is turned to dispYaw), making a collider/visual mismatch obvious
  // at a glance in ?debug=1. New geometry — the old overlay only drew the movement capsule.
  _addPlayerShotWire(entry) {
    if (!entry || !entry.mesh || entry.shotWire) return;
    const rules = this.rules || {};
    const baseR = rules.playerRadius != null ? rules.playerRadius : 0.4;
    const halfCyl = rules.playerHalfHeight != null ? rules.playerHalfHeight : 0.5;
    const baseY = entry.mesh.userData.baseY || 0;
    const type = entry.disguiseType;
    let w, h, d, centerAboveFoot;
    if (type && this.catalog && this.catalog[type]) {
      const he = halfExtentsFor(this.catalog[type]);
      w = he.hx * 2; h = he.hy * 2; d = he.hz * 2;
      centerAboveFoot = he.hy; // disguise base rests on the foot; centre halfH above it
    } else {
      // Capsule-matching sensor (undisguised): a box hugging the base movement capsule.
      w = d = baseR * 2;
      h = 2 * (baseR + halfCyl);
      centerAboveFoot = baseR + halfCyl;
    }
    const wire = this._wireBox(w, h, d, 0xff8c1a);
    wire.position.y = centerAboveFoot - baseY;
    entry.mesh.add(wire);
    entry.shotWire = wire;
  }

  // ---- TRUE Rapier collider overlay (debug menu "True Colliders") -----------
  // Unlike setColliderView (box/capsule approximations), this draws the ACTUAL shapes Rapier
  // is simulating — read straight from the live physics world, in their real form (cuboid /
  // ball / capsule / cylinder / cone / convex hull / trimesh). A "compound" collider is just
  // several colliders on one body, so it appears naturally as several wires. Whole point: SEE
  // the polygon/mesh colliders so a hitbox mismatch (the counter bug) is visible, not guessed.
  setTrueColliderView(on) {
    this._trueColliderOn = !!on;
    if (!this._trueColliderOn) this._clearTrueColliderView();
    // When turned ON, the next updateTrueColliders(world) frame builds the wires (it needs the
    // live physics world, which only main.js/debug.js holds).
  }

  _clearTrueColliderView() {
    if (this._trueColliderGroup) {
      this.scene.remove(this._trueColliderGroup);
      this._trueColliderGroup.traverse((o) => {
        if (o.geometry && o.geometry.dispose) o.geometry.dispose();
        if (o.material && o.material.dispose) o.material.dispose();
      });
    }
    this._trueColliderGroup = null;
    this._trueColliderWires.clear();
  }

  // Refresh the true-collider wires from a live PhysicsWorld. Called every frame (from the
  // debug menu) while the toggle is on. `physicsWorld` is a PhysicsWorld whose `.world` is the
  // Rapier World: on a guest that's the LOCAL prediction world (static geometry + props + the
  // local player's own capsule — the collider set that exists in-browser); on the host it's the
  // authoritative world (which ALSO holds remote players' capsules). Geometry is built ONCE per
  // collider handle (a trimesh read is expensive) and only the transform is tracked each frame;
  // a handle whose shape changed (disguise resize) rebuilds; a vanished handle is pruned.
  updateTrueColliders(physicsWorld) {
    if (!this._trueColliderOn) return;
    const rWorld = physicsWorld && physicsWorld.world;
    if (!rWorld || typeof rWorld.forEachCollider !== 'function') { this._clearTrueColliderView(); return; }
    if (!this._trueColliderGroup) {
      this._trueColliderGroup = new THREE.Group();
      this._trueColliderGroup.renderOrder = 999;
      this.scene.add(this._trueColliderGroup);
    }
    const seen = this._trueSeen;
    seen.clear();
    rWorld.forEachCollider((col) => {
      const h = col.handle;
      seen.add(h);
      let rec = this._trueColliderWires.get(h);
      const key = this._trueShapeKey(col);
      if (!rec || rec.key !== key) {
        if (rec && rec.obj) {
          this._trueColliderGroup.remove(rec.obj);
          if (rec.obj.geometry && rec.obj.geometry.dispose) rec.obj.geometry.dispose();
        }
        const obj = this._buildTrueColliderWire(col);
        if (!obj) { this._trueColliderWires.delete(h); return; }
        rec = { obj, key };
        this._trueColliderGroup.add(obj);
        this._trueColliderWires.set(h, rec);
      }
      const t = col.translation();
      const q = col.rotation();
      rec.obj.position.set(t.x, t.y, t.z);
      rec.obj.quaternion.set(q.x, q.y, q.z, q.w);
    });
    for (const [h, rec] of this._trueColliderWires) {
      if (!seen.has(h)) {
        this._trueColliderGroup.remove(rec.obj);
        if (rec.obj.geometry && rec.obj.geometry.dispose) rec.obj.geometry.dispose();
        this._trueColliderWires.delete(h);
      }
    }
  }

  // A cache key that changes only when a collider's SHAPE (not its transform) changes, so a
  // disguise-resize or prop swap rebuilds the wire while a moving prop just re-tracks.
  _trueShapeKey(col) {
    const s = col.shape;
    if (!s) return 'none';
    const t = s.type;
    if (s.halfExtents) return `c${t}:${s.halfExtents.x},${s.halfExtents.y},${s.halfExtents.z}`;
    if (s.vertices) return `v${t}:${s.vertices.length}`;
    if (s.radius != null && s.halfHeight != null) return `r${t}:${s.radius},${s.halfHeight}`;
    if (s.radius != null) return `b${t}:${s.radius}`;
    return `t${t}`;
  }

  // Build a wireframe LineSegments for ONE collider from its real Rapier shape. Colour is a
  // distinct bright MAGENTA so, drawn over the old yellow/green box overlay, any disagreement
  // (the counter bug) reads at a glance. Local geometry only — the caller places it each frame
  // from the collider's live world transform. Returns null for unsupported shapes (none used
  // by this game today: segment / heightfield / half-space).
  _buildTrueColliderWire(col) {
    const s = col.shape;
    if (!s) return null;
    const COLOR = 0xff37e6; // magenta — distinct from the AABB overlay (grey/red/cyan/yellow/green/orange)
    const t = s.type;
    let solid = null; // a solid geometry we derive the wireframe/edges from
    let allEdges = false; // true = show every triangle edge (mesh/round shapes); false = hard edges (box)
    if (s.halfExtents) {
      // Cuboid / RoundCuboid — clean box edges.
      const he = s.halfExtents;
      solid = new THREE.BoxGeometry(Math.max(he.x * 2, 1e-3), Math.max(he.y * 2, 1e-3), Math.max(he.z * 2, 1e-3));
    } else if (s.vertices && (t === 6 || t === 9 || t === 16)) {
      // TriMesh (6) / ConvexPolyhedron (9) / RoundConvexPolyhedron (16) — the REAL polygon mesh.
      solid = new THREE.BufferGeometry();
      solid.setAttribute('position', new THREE.BufferAttribute(new Float32Array(s.vertices), 3));
      if (s.indices && s.indices.length) solid.setIndex(new THREE.BufferAttribute(new Uint32Array(s.indices), 1));
      allEdges = true;
    } else if (s.radius != null && s.halfHeight != null) {
      // Capsule (2) / Cylinder (10) / Cone (11) + rounded variants. Rapier halfHeight is half the
      // straight (cylinder) section, so the Three primitive's length/height = 2*halfHeight.
      const r = Math.max(s.radius, 1e-3);
      const len = Math.max(s.halfHeight * 2, 1e-3);
      if (t === 10 || t === 14) { solid = new THREE.CylinderGeometry(r, r, len, 16); }
      else if (t === 11 || t === 15) { solid = new THREE.ConeGeometry(r, len, 16); }
      else { solid = new THREE.CapsuleGeometry(r, len, 6, 12); allEdges = true; }
    } else if (s.radius != null) {
      // Ball — sphere.
      solid = new THREE.SphereGeometry(Math.max(s.radius, 1e-3), 14, 10);
      allEdges = true;
    } else {
      return null; // segment / heightfield / half-space — not used in this game
    }
    const wireGeo = allEdges ? new THREE.WireframeGeometry(solid) : new THREE.EdgesGeometry(solid);
    solid.dispose();
    const mat = new THREE.LineBasicMaterial({ color: COLOR, transparent: true, opacity: 0.9 });
    const seg = new THREE.LineSegments(wireGeo, mat);
    seg.renderOrder = 999;
    seg.frustumCulled = false;
    return seg;
  }

  // ---- debug menu: free cam (?debug=1) --------------------------------------
  // Detach the camera and fly it locally. Rendering-only: the physics player stays put
  // (js/main.js also stops feeding it movement while free cam is on), and nothing goes
  // over the network. Seed the fly position from the live camera so enabling is seamless.
  setFreeCam(on) {
    this._freeCam = !!on;
    if (this._freeCam) this._fcPos.copy(this.camera.position);
    // Turning the fly-cam OFF in first-person drops the body it was temporarily
    // showing (a first-person hunter goes back to no self body). Turning it ON in
    // first-person lets the next _syncSelf build the body for the fly-cam to see.
    else if (!this._wantSelfMesh()) this._removeSelfMesh();
  }

  // Advance a fly eye position `p` one frame from input `inp` ({ yaw, pitch, mx, mz, up, dt,
  // boost }) and aim the camera along the look. yaw/pitch are absolute look angles (drag-to-look
  // works on touch + desktop), mx/mz the planar move intent (WASD/joystick), up the vertical
  // (jump = up), boost a speed multiplier. Uses the SAME forward/right convention as movement/aim.
  // Optional `clamp(p)` keeps the eye inside bounds (spectator). Shared by the debug free cam
  // (updateFreeCam) and the spectator fly cam (updateSpectateFly).
  _flyStep(p, inp, clamp) {
    const dt = inp.dt > 0 ? Math.min(0.05, inp.dt) : 0.016;
    const yaw = inp.yaw || 0;
    const pitch = Math.max(-1.4, Math.min(1.4, inp.pitch || 0));
    const speed = inp.boost ? 20 : 8;
    const cp = Math.cos(pitch);
    const fx = -Math.sin(yaw) * cp, fy = Math.sin(pitch), fz = -Math.cos(yaw) * cp; // forward
    const rx = Math.cos(yaw), rz = -Math.sin(yaw); // right (planar)
    const mz = inp.mz || 0, mx = inp.mx || 0, up = inp.up || 0;
    p.x += (fx * mz + rx * mx) * speed * dt;
    p.y += (fy * mz + up) * speed * dt;
    p.z += (fz * mz + rz * mx) * speed * dt;
    if (p.y < 0.3) p.y = 0.3; // don't sink below the ground plane
    if (clamp) clamp(p);
    this.camera.position.copy(p);
    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(p.x + fx, p.y + fy, p.z + fz);
  }

  // Advance the DEBUG free cam one frame (?debug=1). No bounds clamp — a dev may want to fly out.
  updateFreeCam(inp) {
    if (!this._freeCam) return;
    this._flyStep(this._fcPos, inp);
  }

  // ---- spectator (dead player) camera ---------------------------------------
  // A dead player spectates with a free-flying camera (fly mode) that can switch to orbiting a
  // live player (follow mode — reuses the third-person orbit via spectateFollow). Both modes are
  // driven from js/main.js each frame; the physics player stays dead/frozen on the host and NOTHING
  // goes over the network (spectating is purely client-side). Seed the fly eye from the live camera
  // so entering is seamless (the death spot).
  enterSpectate() {
    this._specPos.copy(this.camera.position);
    if (this._specPos.y < 1.4) this._specPos.y = 1.4; // lift off the floor a touch
    // Hide the dead player's OWN body while spectating so it doesn't hang in the fly/follow view
    // (setCamera — which normally toggles selfMesh.visible — is skipped while spectating). It's
    // rebuilt/re-shown on respawn via the next setCamera. No-op for a first-person hunter (no body).
    if (this.selfMesh) this.selfMesh.visible = false;
  }

  // FLY mode: advance the free-flying spectator eye, clamped INSIDE the map so nobody flies into
  // the void. `inp` adds { half, yMin, yMax } bounds (map half-size + vertical limits) to the
  // usual fly input. No collision (fly through walls freely), just the outer arena box.
  updateSpectateFly(inp) {
    const half = inp.half > 0 ? inp.half : 1e6;
    const yMin = inp.yMin != null ? inp.yMin : 0.5;
    const yMax = inp.yMax != null ? inp.yMax : 1e6;
    this._flyStep(this._specPos, inp, (p) => {
      if (p.x < -half) p.x = -half; else if (p.x > half) p.x = half;
      if (p.z < -half) p.z = -half; else if (p.z > half) p.z = half;
      if (p.y < yMin) p.y = yMin; else if (p.y > yMax) p.y = yMax;
    });
  }

  // FOLLOW mode: orbit the SAME third-person camera the props use around a watched player's
  // position `pos` ({x,y,z}) for the given look angles. Reuses _orbitCameraTo (not a second
  // follow-cam), so what a spectator sees while following is identical to third-person play.
  spectateFollow(pos, yaw, pitch) {
    const target = this._vTarget.set(pos.x, this._camHeadY + (pos.y || 0), pos.z);
    this._orbitCameraTo(target, yaw, pitch);
  }

  // Live rendered position of a player (self or remote), or null if their mesh isn't built yet.
  // The spectator follow-cam reads this so it tracks the smoothly-interpolated mesh (not the 15 Hz
  // snapshot). Public wrapper over the taunt-emitter's _playerWorldPos.
  playerViewPos(id) {
    const p = this._playerWorldPos(id);
    return p ? { x: p.x, y: p.y, z: p.z } : null;
  }

  // ---- debug menu: focus box + click-to-inspect (?debug=1) ------------------
  // Raycast from the CAMERA CENTRE (crosshair) and return a plain info object describing
  // the entity under it (or null). Also refreshes the magenta focus box onto that entity
  // when the box is enabled. Reuses this._raycaster; targets are the prop primitives (still
  // hittable when invisible after a GLB swap), player meshes, and static fixtures — NOT the
  // arena walls. This reveals a disguised player's identity ON PURPOSE (that's the point of
  // a debug inspector); it's gated behind ?debug=1 like everything else.
  debugPick() {
    if (!this.camera) return null;
    this.camera.updateMatrixWorld(); // the fly-cam moved this frame; keep the ray current
    this._raycaster.setFromCamera(this._aimNDC || SCREEN_CENTER, this.camera);
    this._raycaster.far = 60;
    const roots = this._debugTargets();
    if (!roots.length) { this._setFocusTarget(null); return null; }
    const hits = this._raycaster.intersectObjects(roots, true);
    let info = null, root = null;
    for (const h of hits) {
      root = this._debugRoot(h.object);
      if (root) { info = this._debugInfoFor(root); break; }
    }
    this._setFocusTarget(root);
    return info;
  }

  // Enable/disable the focus box (the per-frame highlight). Inspect (debugPick's return
  // value) works regardless; this only controls whether the box is drawn.
  setFocusBox(on) {
    this._focusBoxOn = !!on;
    if (!this._focusBoxOn && this._focusBox) this._focusBox.visible = false;
  }

  _debugTargets() {
    const roots = [];
    if (this.propMeshes) for (const rec of this.propMeshes.values()) if (rec.primitive) roots.push(rec.primitive);
    for (const entry of this.players.values()) if (entry.mesh) roots.push(entry.mesh);
    if (this.selfMesh) roots.push(this.selfMesh);
    for (const m of this.colliders) if (m.userData && m.userData.debugFixtureType) roots.push(m);
    return roots;
  }

  // Climb from a raycast-hit child to the nearest ancestor carrying a debug identity.
  _debugRoot(obj) {
    let o = obj;
    while (o) {
      const u = o.userData;
      if (u && (u.propId != null || u.debugPlayerId != null || u.debugFixtureType != null)) return o;
      o = o.parent;
    }
    return null;
  }

  _debugInfoFor(root) {
    const u = root.userData || {};
    const wp = root.getWorldPosition(this._fbCenter); // updates the world matrix → accurate
    const pos = { x: wp.x, y: wp.y, z: wp.z };
    if (u.propId != null) {
      const rec = this.propMeshes && this.propMeshes.get(u.propId);
      const type = (rec && rec.type) || '?';
      const c = (this.catalog && this.catalog[type]) || {};
      const cont = rec && rec.container;
      const rot = cont ? this._fbEuler.setFromQuaternion(cont.quaternion) : { x: 0, y: root.rotation.y, z: 0 };
      return {
        kind: 'prop', id: u.propId, type,
        catalog: c.shape ? c.shape + (c.model ? ' · ' + c.model : '') : '(unknown)',
        pos, rot: { x: rot.x, y: rot.y, z: rot.z },
        body: rec && rec.disguisable === false ? 'dynamic (fixture)' : 'dynamic',
        sleeping: 'host-only', disguisedPlayer: false,
      };
    }
    if (u.debugFixtureType != null) {
      const type = u.debugFixtureType;
      const c = (this.catalog && this.catalog[type]) || {};
      return {
        kind: 'fixture', id: null, type,
        catalog: c.shape ? c.shape + (c.model ? ' · ' + c.model : '') : '(unknown)',
        pos, rot: { x: root.rotation.x, y: root.rotation.y, z: root.rotation.z },
        body: 'static', sleeping: 'n/a (static)', disguisedPlayer: false,
      };
    }
    // Player.
    const id = u.debugPlayerId;
    const isSelf = id === this.selfId;
    const kind = isSelf ? this.selfKind : (this.players.get(id) && this.players.get(id).kind);
    const disguised = !!(kind && kind.indexOf('d:') === 0);
    const disguiseType = disguised ? kind.slice(2) : null;
    const role = disguised ? 'prop' : (kind && kind.indexOf('hunter') === 0 ? 'hunter' : 'prop');
    return {
      kind: 'player', id, type: 'player' + (isSelf ? ' (you)' : ''),
      catalog: disguised ? 'disguised as ' + disguiseType : (role === 'hunter' ? 'hunter avatar' : 'undisguised prop'),
      pos, rot: { x: 0, y: root.rotation.y, z: 0 },
      body: 'kinematic', sleeping: 'n/a', role, alive: root.visible,
      disguisedPlayer: disguised, disguiseType,
    };
  }

  _setFocusTarget(root) {
    this._focusTarget = root || null;
    this._updateFocusBox();
  }

  _updateFocusBox() {
    if (!this._focusBoxOn) { if (this._focusBox) this._focusBox.visible = false; return; }
    const root = this._focusTarget;
    if (!root || !root.parent) { if (this._focusBox) this._focusBox.visible = false; return; }
    const box = this._fbBox.setFromObject(root);
    if (box.isEmpty()) { if (this._focusBox) this._focusBox.visible = false; return; }
    const b = this._ensureFocusBox();
    box.getSize(this._fbSize);
    box.getCenter(this._fbCenter);
    b.position.copy(this._fbCenter);
    b.scale.set(this._fbSize.x || 0.1, this._fbSize.y || 0.1, this._fbSize.z || 0.1);
    b.visible = true;
  }

  _ensureFocusBox() {
    if (!this._focusBox) {
      const geo = new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1));
      // Magenta — deliberately distinct from the green disguise highlight and the
      // yellow/cyan/red collider-debug wires so four box systems read apart at a glance.
      const mat = new THREE.LineBasicMaterial({ color: 0xff2fd0 });
      this._focusBox = new THREE.LineSegments(geo, mat);
      this._focusBox.renderOrder = 999;
      this._focusBox.frustumCulled = false; // unit bounds; scaled per target
    }
    if (!this._focusBox.parent) this.scene.add(this._focusBox); // re-attach after scene.clear()
    return this._focusBox;
  }

  render() {
    // LIGHTING OVERHAUL: the rig picks direct render (T0/T1) vs the SSAO/bloom composer (T2/T3).
    // Falls back to a direct render while an async post-import is still loading — never a black frame.
    if (this.lighting) this.lighting.render();
    else this.renderer.render(this.scene, this.camera);
  }
}
