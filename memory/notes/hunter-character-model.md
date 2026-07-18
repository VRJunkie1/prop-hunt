# Hunter character model (v1) — animated SWAT soldier

## 2026-07-18 B7 — HELD TOOL now visible on the model (VRmike)

The remote hunter's held item is no longer always the rifle. The hunter's SELECTED tool is now
synced (host-authoritative `C2S.SELECT_TOOL` → snapshot `tool`), and `_buildHunterModel` builds
all three held meshes (rifle GLB + grenade/finder primitives) on the `Wrist.R` bone; `_apply
HeldTool` toggles which is visible per hunter each snapshot (`syncPlayers`). This SUPERSEDES the
"tool state is NOT networked / a remote hunter always animates gun-up" note below — the ANIMATION
still forces the gun-up clips (there's no grenade/finder-specific run clip in the asset), but the
HELD ITEM now matches the tool. Full detail: `notes/hunter-tool-visibility.md`. `setWeaponVisible`
is superseded by `_applyHeldTool` (kept as an unused manual override).


Built 2026-07-11 (VRmike task "HUNTER CHARACTER MODEL v1"). Gives remote **hunters**
an animated third-person soldier body — what OTHER players (props) see. The LOCAL
hunter stays first-person and never renders their own body. Props are
untouched (still render as their disguise). NOT playtested live (headless sandbox
can't open a GLB or run animations — see "Verification" below).

## 2026-07-12 RIFLE 180° FLIP — barrel pointed BACKWARDS in remote view (VRmike)

Symptom: in other players' view the hunter's rifle pointed BEHIND them (screenshot in the
request). Root cause: the "SOLVED" rotation below ASSUMED the GLB barrel was the **-X** end and
solved so that -X → world-forward. But live, the muzzle is actually the **+X** end — so the
solve sent the real muzzle to world-BACKWARD. This is exactly the "last blind rotation got the
sign wrong" the task warned about.

Fix (verified against the actual bone transform, NOT eyeballed): re-ran `tools/_solve_rifle.mjs`
and took its **`[muzzle+X, up+Y]`** variant — the SAME rig-derived solve, muzzle axis corrected.
`weapon.rotationDeg {178.8, -10.1, 87.6} → {-1.2, 10.1, 92.4}`. The tool's numeric verify prints
`barrel=(0,0,-1)` (forward −Z) and `up=(0,1,0)` across Idle_Gun_Pointing / Run_Shoot / Gun_Shoot /
Idle_Gun_Shoot. This is precisely a 180° turn (barrel reversed, gun still upright) relative to the
old value. Headless RENDER is impossible in the sandbox → confirm live; hot-tunable if still off.
`tools/check-hunter-model.mjs` stays GREEN (clip/asset contract unchanged).

## 2026-07-12 RIFLE POSE/ANIM POLISH — rifle points at the ground + arm drops when idle (VRmike)

Before (VRmike's live screenshots — the remote hunter holds the rifle pointing at the ground):

<img src="assets/attached_0.png" width="360"> <img src="assets/attached_1.png" width="360">

The prior fix (below) mapped movement to `Run_Shoot` and idle to `Idle_Gun`, but VRmike's live
screenshots still showed the rifle POINTING AT THE GROUND while running and the arm DROPPING when
idle. Root cause was NOT the clip selection — it's the **attachment orientation vs the rig pose**,
and it differs per clip:

- **Diagnosed with real matrix math (headless), not eyeballing.** `tools/_solve_rifle.mjs` loads
  the SWAT rig (three + GLTFLoader), poses it in each gun clip, and reads the `Wrist.R` WORLD
  quaternion. Findings: with `weapon.rotationDeg = 0`, the barrel points nearly straight **DOWN**
  in the shoot/aim clips (`Idle_Gun_Pointing` / `Gun_Shoot` / `Idle_Gun_Shoot` / `Run_Shoot` all
  share one wrist orientation), and points **BACKWARD** in the OLD `Idle_Gun`. So the running "gun
  down" and the idle "arm drops/awkward" were the SAME attachment bug, and no single rotation could
  fix both while idle used the odd-one-out `Idle_Gun`.
- **Fix, two parts:**
  1. **idle `Idle_Gun` → `Idle_Gun_Pointing`** — a real static AIM-IDLE that holds the rifle raised
     and pointing forward AND shares the shoot clips' wrist orientation. Now idle + all movement
     clips share one wrist frame, so ONE attachment rotation fixes every state. (This also directly
     answers "keep the arm up when idle" — a genuine aim-idle clip exists in the asset.)
  2. **`weapon.rotationDeg = {x:178.8, y:-10.1, z:87.6}`** — SOLVED so the muzzle (the rifle's
     **-X** end; thin barrel = fewer verts, confirmed by `tools/_muzzle.mjs`) points along the
     character's forward and gun-up points to world-up. Verified across Idle_Gun_Pointing /
     Run_Shoot / Gun_Shoot / Idle_Gun_Shoot: barrel within ~1° of level-forward, gun upright, in
     ALL of them. Hot-tunable (Euler XYZ, bone-local); nudge z by ±180 / flip a sign live if the
     grip roll or muzzle facing reads off (the build sandbox can't render, so the exact roll is a
     live-confirm item; the barrel DIRECTION is solved and correct).
- **Guard unchanged + still valid:** `check-hunter-model.mjs` parses the GLB and asserts every
  configured clip is a Gun/Shoot clip — `Idle_Gun_Pointing` carries "Gun", so a rifle hunter can
  never drop to the arms-at-side idle. The derivation tools (`_solve_rifle.mjs`, `_muzzle.mjs`) are
  authoring-only and never ship.

## 2026-07-12 fix — remote hunter shown arms-at-sides while holding the rifle (VRmike)

Live 2-player: remote hunters ran with the **default arms-at-sides run** even though the rifle
was attached — the gun-up animations weren't showing. Root-caused at the ASSET, not the code:
parsed the SWAT GLB (clip names are plain text in the glTF JSON chunk — `tools/_probe_glb_clips.mjs`
one-off, now folded into `check-hunter-model.mjs::glbClipNames`). The 24 clips include only **two**
that keep the rifle raised: `Idle_Gun` (gun idle) and `Run_Shoot` (a real gun-up run). The old
config mapped backward/left/right to `Run_Back`/`Run_Left`/`Run_Right`, which are the pack's PLAIN
arms-down directional runs — so any strafe/backpedal dropped the gun (the mixer, snapshot-derived
velocity, and wiring were all fine; it was purely the clip choice). **There is no gun-up
strafe/backpedal clip in this asset**, so `character-models.json` now maps ALL movement states to
`Run_Shoot` (idle stays `Idle_Gun`) — rifle stays UP in every direction. Trade-off: legs use the
forward-run cycle while strafing. Hot-tunable. `check-hunter-model.mjs` now parses the GLB and
asserts every configured clip resolves in the asset AND is a rifle/aim clip (name carries Gun/Shoot),
so a regression that points a movement state back at a plain run fails the build.

Honest note on the task's premise: it assumed tool state was replicated and the animation should
"follow the rifle tool." Tool state is NOT networked (the finder is a deliberate no-op; the rifle
is always shown on remotes via `weapon.visibleByDefault`). So "animation follows the rifle" reduces
to "a remote hunter always animates gun-up" — which forcing the gun clips achieves. No netcode added.

## 2026-07-11 fix pass (live 2-player testing, VRmike)

Live test found the remote soldier mis-sized/mis-placed/back-facing and the local
hunter still third-person. Diagnosed root cause: the model had been mentally attached
to the orbiting third-person camera. The tree already anchored it to the PLAYER BODY
(`syncPlayers` positions the mesh at the snapshot `p.x/p.y/p.z`, feet at `-box2.min.y`,
scale `targetH / size.y` from the measured bbox — all correct), so the position/scale
fixes were already present. Two changes landed this pass:
- **Facing:** `yawOffsetDeg` **0 → 180** (the soldier faced backwards; native forward
  is +Z, game forward is −Z). Hot-tunable — nudge if a live browser still shows it off.
- **Local hunter is now genuinely first-person** (was still third-person, showing the
  red capsule to yourself): `js/main.js applyRoleView()` sets `scene.setThirdPerson(role
  !== HUNTER)`. See `memory/notes/third-person-camera.md` for the camera/self-body detail
  and the free-cam-still-shows-your-body handling.

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
2. **Facing** — `yawOffsetDeg` is now **180** (fixes the faces-backwards symptom). If a
   live browser shows it running sideways/still-backwards, nudge from there.
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
