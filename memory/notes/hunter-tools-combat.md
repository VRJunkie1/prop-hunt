# Hunter Tools v1 + Health / Damage (2026-07-12, VRmike)

## 2026-07-19 — PROP HEALTH SCALING: SIZE-COMPARISON FACTOR (VRmike balance tweak)
- **The disguise damage curve is no longer a lerp between size anchors — it's a size RATIO to the
  player.** VRmike: bigger prop players were too easy to kill (the old lerp gave a fridge ~1.88 m a
  2.43× multiplier — MORE than base — because only ≥`largeSize` 2.2 m hit the tanky `largeMult`).
- **New `sizeMultiplier(size, cfg)` (shared/damage.js):**
  `mult = 1 / (propSize / (playerSize * sizeComparisonFactor)) = (playerSize * sizeComparisonFactor) / propSize`,
  then CLAMPED to `[largeMult, smallMult]`. Neutral (mult 1.0 = plain base) is a prop whose size ==
  `playerSize * sizeComparisonFactor`. With the default **0.6** that's 0.6× the player (~1.08 m).
  Real outcomes at base 5: burger 0.72 m → **1.5×** (7.5/hit, ~14 hits — fragile, still faster than
  the 20-hit undisguised player), fridge 1.88 m → **0.57×** (~35 hits), table 2.25 m → **0.48×**
  (~42 hits). Monotonic: bigger prop ⇒ tankier.
- **`sizeComparisonFactor`** is THE tunable, `rules.json` `damage.sizeComparisonFactor` (default 0.6).
  Lower it ⇒ pivot drops ⇒ every prop tankier (big props gain most). One-number hot-tune, no rebuild.
- **`playerSize`** is derived, not authored: `playerSizeFromRules(rules) = 2*(playerRadius+playerHalfHeight)`
  = 1.8 m (the capsule's longest dimension, same "longest full dimension" `entrySize` gives a prop).
  The referee injects the LIVE value via `_damageCfg()` (used by both `_playerHitDamage` and the grenade
  blast) so the pivot tracks the real capsule if those dims are retuned. `resolveDamageCfg` defaults it
  to 1.8 for pure/offline callers.
- **Clamps are unchanged guardrails:** `smallMult` (10) = multiplier CEILING (a prop < pivot/10 ≈ 0.11 m
  can't be one-shot-vaporised), `largeMult` (0.34) = FLOOR (a huge prop can't go immortal). Neither binds
  for any real catalog prop now — they're pure safety rails.
- **`smallSize`/`largeSize` (0.72 / 2.2) are KEPT in `rules.damage`** but are NO LONGER read by the damage
  curve. They now anchor ONLY the prop-"ouch" pitch curve (`resolveOuchCfg`, `js/main.js` → `dcfg.smallSize/
  largeSize`; `check-combat-sfx.mjs` A2 asserts ouch==damage anchors). Don't delete them.
- **Nothing else changed:** wrong-guess penalty still flat `base`; grenade prop-player damage rides the same
  `multiplierForDisguise` (so it retuned automatically — `check-grenade.mjs` still green). `check-combat.mjs`
  **section A** rewritten to assert the ratio formula: pivot ⇒ 1.0, the exact `1/(propSize/(playerSize*factor))`
  in the unclamped band, both clamps, monotonic, the lower-factor-⇒-tankier lever, and VRmike's three named
  cases (burger HIGH, fridge LOW, table < fridge). Sections B–G untouched and green; page boots clean.

## 2026-07-12 addendum — damage-multiplier PROOF + RAPID FIRE

- **Size-multiplier "bug" — the referee was already correct; proven, not re-patched.** VRmike
  reported a prop that goes small then re-disguises large keeps the small multiplier and dies
  fast. Investigation (a probe driving the real `Referee`, plus `git_diff` of the damage commits,
  plus the client `tryDisguise` path) showed `_applyShotDamage` has ALWAYS derived the multiplier
  FRESH from `target.disguise` at damage time — there is NO cached per-player multiplier anywhere,
  and the client allows + sends a re-disguise. The probe confirmed the multiplier updates 10 → 0.34
  (damage 50 → 1.7) on a small→large re-disguise. Made the guarantee explicit via
  `referee._playerHitDamage(target)` and LOCKED it with `check-combat.mjs` **section E**
  (small → re-disguise large → assert per-hit damage matches the LARGE prop, not the stale small
  one). If it still reproduces live, the deployed build predates this branch or the cause is
  elsewhere (client not sending the re-disguise) — recommend an instrumented build, not a 2nd
  blind patch.
- **RAPID FIRE.** `rules.fireRateRpm` (700, config-tunable). Host cap `referee._fireCooldownMs()`
  = `max(10, 60000/rpm − 20)` (grace so a legit client isn't throttled below rate; still caps a
  cheat). Client paces held-fire off the same rpm. Damage/bullet unchanged (5%). See
  `notes/pause-menu.md` for the input/mouse-lock/pause side.


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
  **HITBOX ACCURACY (2026-07-13):** a player is hit through a disguise-shaped SHOT SENSOR, not
  the movement capsule — `raycastShot` excludes movement capsules so shots match the visible
  disguise (corners hit; no phantom hit above a low disguise; no double-hit). See
  `notes/hitbox-accuracy.md`.
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

## 2026-07-12 damage tuning (VRmike) — flat wrong-guess penalty + rescaled base
- **base 10 → 5** (`rules.damage.base`): 5%/hit; an undisguised player = 20 hits.
- **WRONG-GUESS penalty is now FLAT `base`, size multiplier NEVER applied.** New pure
  `damage.wrongGuessPenalty(cfg)` = `base`. The referee's two decoy branches (`kind:'prop'` +
  `kind:'fixture'`) in `_applyShotDamage` call it instead of `selfScalesWithSize ? multiplier : 1`
  — so a burger decoy and a table decoy both cost the hunter exactly 5% (20 wrong guesses = dead).
  `rules.damage.selfScalesWithSize` is retired to `false` and NO LONGER read (the flat rule is
  unconditional). Real architecture/world is still a free miss.
- **Prop-PLAYERS keep the size curve, rescaled for the new base.** `smallMult 5 → 10` so a small
  disguise still ≈ 2 hits at base 5 (burger: 5×10 = 50 → 2 hits — same per-hit as the old 10×5).
  `largeMult 0.34` kept: table ≈ 5×0.34 = 1.7/hit → ~59 hits ≈ ~3× the 20-hit default. Smooth
  lerp between `smallSize`/`largeSize` intact — the multiplier math is untouched; only the base
  and small anchor moved. `damage.js` stays the ONE size source (referee + `check-combat.mjs`).
- `tools/check-combat.mjs` extended: asserts the flat penalty is size-INDEPENDENT (burger-decoy ==
  table-decoy == base, despite very different size multipliers), burger ≈ 2 hits, table ≈ 3× default.

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
