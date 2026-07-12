# Hunter Tools v1 + Health / Damage (2026-07-12, VRmike)

The build that adds an on-screen hunter **tool bar**, an **assault rifle** (muzzle flash +
tracer visible to everyone), a no-op **prop finder** (proves tool switching), a
host-authoritative **health/damage** system, and the **all-hunters-dead → props win** round
end. Retry of a run that crashed with an Exception — the crashed run had committed nothing,
so this started from the last-good commit (8e28bc3) with a clean tree.

## Tool framework (client-only; NOT networked in v1)
- `HUNTER_TOOLS` in `js/main.js` — `[{id,name,key}]`, built for 4+ tools; two ship
  (`rifle` default, `finder`). `state.tool` holds the selection.
- **Tool bar** (`#toolbar`, `ui.buildToolbar/setToolbar`): always-on for a LIVE hunter,
  current tool highlighted. Tap (pointerdown) on phones, click on PC, number keys **1/2**
  (`input.onSelectTool` → `main.selectTool`). Hidden for props / dead / lobby.
- **First-person viewmodel** (`scene.setViewModel(toolId)`): the local hunter is
  first-person (draws no own body), so tool switching is made visible to the shooter via a
  weapon VIEWMODEL parented to the camera — the real rifle GLB (falls back to a primitive
  barrel until the async GLB loads, then `updateEffects` upgrades it), or a ~0.3 m box for
  the finder. The camera is now `scene.add`-ed to the scene graph so its child viewmodel
  renders; re-parented after `buildWorld`'s `scene.clear()`.
- **Why no held-tool sync:** the finder is a deliberate no-op, so syncing which tool a
  hunter holds is netcode for no payoff (per the approved critique). Only the FIRE event is
  broadcast. A later tool that needs the silhouette on other screens can add the sync.

## Assault rifle — host-authoritative (client suggests aim, host validates)
- Fire: `main.tryFire()` (hunter primary action / left-click, tool==rifle, alive) sends
  `C2S.SHOOT {dx,dy,dz}` = the camera-forward from `scene.aimDirection()` — the SAME
  screen-centre ray `aimedDisguiseTarget` uses for the disguise pick (reused, as required).
- Host (`referee.applyShot`): rate-limited (`rules.fireCooldownMs`), HUNTING-only. Builds
  the ray from the shooter's AUTHORITATIVE eye (`pos + 1.5`) along the client's aim dir,
  and re-casts it in its own Rapier world (`physics.raycastShot` → `world.castRay`,
  excluding the shooter's own capsule+body). Trusting only the aim DIRECTION isn't a cheat
  (you can always aim); the host owns WHAT was hit. `physics.describeCollider(handle)`
  classifies the hit via handle→entity maps built at world construction:
  `_propHandleToId` (props), `_staticFixtureTypeByHandle` (map fixtures by type), players by
  live collider handle, else `world` (ground/boundary walls = free-miss architecture).
- Everyone sees the shot: host broadcasts `EVENT kind:'shot' {by, o*, i*, hit}` (muzzle o*,
  impact i*); `scene.spawnTracer` draws a cylinder tracer + a muzzle-flash sphere,
  `scene.updateEffects` fades/retires them (~0.12 s). No physics world (2D fallback) => a
  no-damage tracer into the distance.

## Health / damage (all host-side — `shared/referee.js` + `shared/damage.js`)
- Everyone starts at `rules.startHealth` (100 %); health rides every snapshot player entry
  and shows on the HUD (`#hudHealth`, `ui.setHealth` green→amber→red). Not a secret.
- `shared/damage.js` (PURE) is the ONE size/damage source, imported by BOTH the referee and
  the guard. `entrySize(c) = 2·max half-extent` from `physics.halfExtentsFor` — the SAME
  footprint physics bakes colliders from, so it auto-upgrades to measured `asset-dims` bounds
  the day that file is populated. `sizeMultiplier` LERPS between config anchors
  (`rules.damage`): `smallSize→smallMult` (tiny, burger 0.72 m → 5× → ~2 hits) down to
  `largeSize→largeMult` (big, table 2.25 m → 0.34× → ~30 hits ≈ 3× the default player's 10).
  An undisguised player uses `defaultMult` (1.0 → plain base hit).
- Rules (`referee._applyShotDamage` from `physics.describeCollider`):
  - **player hit** → that player takes `base × multiplier(their disguise)`.
  - **disguisable object** (a prop instance, or a non-arch static fixture like a
    counter/pillar — a "could-have-been-a-player") → the HUNTER takes the same size-scaled
    damage instead (shoot a decoy, hurt yourself). `selfScalesWithSize` config toggle.
  - **architecture / world** (walls/floor/ceiling/ground) → FREE MISS, no damage.
  - **kill of a prop** by a live hunter → hunter REFILLS to full (`attacker.health = start`).
- Death: `_damagePlayer` flips `alive=false` at 0 HP and announces `EVENT kind:'eliminated'
  {hunter}`. Dead players don't respawn (the physics failsafe already skips `!alive`).

## Death, spectator, win condition (DECISIONS.md #1)
- **Hunters do NOT respawn.** A dead local player gets a spectator banner (`#spectate`) and
  keeps first-person look-around from their death spot (movement stays frozen). This
  OVERRIDES the earlier respawn assumption — recorded as DECISIONS.md ruling #1.
- **`checkRoundOver`** gained the new condition: a round that had hunters and they are ALL
  dead → `endRound(ROLE.PROP)` (HUNTERS LOSE, PROPS WIN). Pre-existing conditions (all props
  caught → hunters win; timer expiry → surviving props win) unchanged. Zero-hunter solo
  rounds never trigger it.

## Verification (`tools/check-combat.mjs` — build-gating)
Drives the REAL shared code paths (no Rapier, no browser): the size→multiplier lerp
(clamps + midpoint + monotonic + real burger/table hit counts), player damage scaling,
kill-refill, wrong-prop self-damage vs architecture free-miss, and BOTH win conditions
(all-hunters-dead → props; all-props-caught → hunters). `tools/check-blindfold.mjs` (the
render-loop contract) covers the new `scene.*` methods (aimDirection/setViewModel/
spawnTracer/updateEffects). `check-physics.mjs` still green (handle maps are additive).

## OWED — live 2-player pass (can't be seen headless)
Tool bar selects on PC (1/2 + click) and phone (tap), current highlighted; rifle/box
viewmodel switches; firing shows a muzzle flash + tracer to BOTH players from the rifle to
the impact; a prop-player takes size-scaled damage (burger ~2 hits, table many); shooting a
decoy object hurts the hunter; a wall is a free miss; killing a prop refills the hunter;
a hunter at 0 HP dies + spectates; last hunter down → PROPS WIN banner. Tune `rules.damage`
anchors + the muzzle offset if the feel/visual is off (all hot-tunable, no rebuild).
