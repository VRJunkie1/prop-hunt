# Hunter character model (v1) — animated SWAT soldier

Built 2026-07-11 (VRmike task "HUNTER CHARACTER MODEL v1"). Gives remote **hunters**
an animated third-person soldier body — what OTHER players (props) see. The LOCAL
hunter stays first-person and never renders their own body this pass. Props are
untouched (still render as their disguise). NOT playtested live (headless sandbox
can't open a GLB or run animations — see "Verification" below).

## What & where

- **Assets** (both CC0, Quaternius, via poly.pizza; fetched with `fetch_asset`, so
  they're in `assets/manifest.json` + `CREDITS.md`):
  - SWAT soldier body: `assets/713f6535-f4f3-4367-a4c6-ced126ae0936.glb` (24 clips
    named `CharacterArmature|<clip>`; bones incl. `Wrist.R`/`Wrist.L`).
  - Assault rifle: `assets/9a0e478c-de82-4773-9b70-a0219bb0057c.glb` (static mesh).
- **Registry — `shared/config/character-models.json` (NEW).** A **separate**
  character-model registry, DELIBERATELY not `props.json`/`fixtures.json`: those feed
  the collider-baking + measured-bounds physics pipeline, which a player character must
  never enter (it would grow a physics collider it shouldn't have). Holds the body/
  weapon GLB filenames, `heightMeters` (capsule match), the 5 movement clip suffixes,
  anim tunables, the **rifle grip offset** (`weapon.position`/`rotationDeg`/`scale`,
  hot-tunable — no rebuild), and a hot-tunable `yawOffsetDeg` facing correction.
- **`js/config.js`** loads it into `cfg.characterModels` (tolerant of absence → capsule
  fallback). **`js/main.js`** passes it into `scene.buildWorld(..., characterModels)`
  and calls `scene.updateAnimations(dt)` each render frame.
- **`js/scene.js`** owns the whole subsystem (see methods below). Reuses the existing
  lazy CDN `GLTFLoader` (nothing at page boot) + a lazily-imported `SkeletonUtils`.

## How it works (scene.js)

- **Load** (`_loadCharacterModels` at match start, fire-and-forget): lazily imports
  GLTFLoader (shared `_ensureGltfLoader`) + `three/addons/utils/SkeletonUtils.js`, then
  loads each referenced GLB into `_charCache` (`{scene, animations}` | `'loading'` |
  `'failed'`). Bodies keep their animation clips; the weapon is a static mesh.
- **Per-hunter build** (`_buildHunterModel`): **rig-safe clone** via
  `SkeletonUtils.clone(body.scene)` — a plain `.clone()` shares/breaks the skinned
  skeleton and freezes animation (known trap, avoided). Scales the model so its HEIGHT
  == the hunter capsule (`CapsuleGeometry(0.4,1.0)` ≈ 1.8 tall), rests feet at the group
  origin (baseY 0) + centres x/z, applies `yawOffsetDeg`. Parents a cloned rifle to the
  `Wrist.R` bone with the config grip offset. Builds an `AnimationMixer` + one
  `clipAction` per movement state. Returns a `Group` with `userData.hunterCtl` (the
  controller: mixer/actions/weapon/tunables).
- **Only remote players** get the model: `meshForPlayer(p, {animated:true})` builds it
  (syncPlayers passes the flag); `_syncSelf` calls `meshForPlayer(p)` with NO flag, so
  the local hunter keeps the neutral capsule / first-person view. Guarded by
  `_hunterModelReady()` (body GLB + SkeletonUtils both ready) — until then a remote
  hunter shows the capsule. The readiness is folded into the entry **kind**
  (`hunter:cap` → `hunter:swat`), so the entry rebuilds into the soldier the instant the
  GLB finishes loading; a failed load stays `hunter:cap` forever (graceful fallback).
- **Animation state machine** (`updateAnimations(dt)` each frame + `_playHunterState`):
  - **Velocity is DERIVED from successive snapshots** — the snapshot carries no
    velocity. Computed once per snapshot arrival in `syncPlayers` (displacement ÷
    measured snapshot dt, smoothed 0.5 to damp net jitter) and stored as `entry.animVel`.
  - stationary (`speed < moveThreshold`) → `idle` (`Idle_Gun`); moving → project
    velocity onto facing (`forward=(-sin yaw,-cos yaw)`, `right=(cos yaw,-sin yaw)`),
    pick the dominant axis → `forward`(`Run_Shoot`)/`backward`(`Run_Back`)/
    `left`(`Run_Left`)/`right`(`Run_Right`). `timeScale = speed/refSpeed` clamped
    [minTS,maxTS]. Crossfade (`fadeOut`/`fadeIn` ~0.15s) — no pop. Missing clip → idle.
- **Clip matching guards the prefix** (`_resolveClip`): the file names every clip
  `CharacterArmature|<clip>`; match is exact → `endsWith('|'+suffix)` → `endsWith(suffix)`.
- **`setWeaponVisible(bool)`** (default visible): shows/hides the rifle on every hunter
  (current + future) while keeping the gun-holding pose — for later tool-switching.
  Not called anywhere yet; the default `_weaponVisible` seeds from
  `weapon.visibleByDefault`.

## No changes to

Netcode/protocol (reuses existing position/yaw snapshot state), physics/colliders,
referee, props/disguises, the local player's view. `shared/` untouched.

## Likely follow-up tweaks (hot-tunable, no rebuild — edit character-models.json)

1. **Rifle grip alignment** — `weapon.position`/`rotationDeg`/`scale`. Quaternius gun +
   Quaternius character should align close out of the box; nudge if the grip looks off.
2. **Facing** — if the soldier runs backwards/sideways relative to travel, set
   `yawOffsetDeg` (likely 180).
3. `Run_Shoot` for `forward` — swap to plain `Run` if the shoot pose looks wrong.
4. `moveThreshold` / `refSpeed` if idle↔run flickers or run speed looks off.

## Verification (honest — headless can't load a GLB or animate)

Static only: `node tools/check-hunter-model.mjs` asserts both GLBs are present +
registered + real glTF binaries, the registry is self-consistent + separate from
props/fixtures, the configured clip suffixes are real pack clips, and the scene methods
+ rig-safe clone + main.js wiring exist. The generic "every `scene.X()` main.js calls is
defined" guard in `tools/check-blindfold.mjs` covers `updateAnimations`/`buildWorld`.
**OWED — live browser pass:** a remote hunter renders the soldier (props see it), it
plays idle/run without console errors, clip names resolve, the rifle sits in the hand,
the model tracks the networked capsule, and the LOCAL hunter still sees nothing of their
own body. Tune grip/facing then.
