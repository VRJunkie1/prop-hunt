# Hunter Grenades — hunter tool #3 (2026-07-17, VRmike)

> **B3 BALANCE UPDATE (2026-07-18):** both blast radii were scaled **×0.6** (playtest nerf — the
> grenade was OP): `fullDamageRadius` 1 → **0.6 m**, `falloffDistance` 2 → **1.2 m**, so the
> derived outer range is **1.8 m** (was 3 m). The "1 + 2 = 3" figures below are the ORIGINAL
> defaults; the authoring style (two separate knobs, not a stored outer) is unchanged, and
> `grenadeFalloff` scales entirely off config. baseDamage / size-mult / backfire / redemption are
> untouched. Live values in `shared/config/rules.json`; see `notes/balance-tuning.md`.

The hunter's THIRD selectable tool, alongside the rifle and the prop finder. Built on top of the
prop-finder's tool-selection infrastructure (three slots now: rifle · finder · grenade). Purpose:
a high-risk area weapon that punishes tiny hard-to-hit props (the size multiplier makes small
props take proportionally more) but can kill the thrower if it only hits decoys.

## Mechanics (spec, faithfully)

- **Selectable tool**: added `{ id: 'grenade', name: 'Grenade', key: '3' }` to `HUNTER_TOOLS`
  (`js/main.js`). Reuses the data-driven tool bar (`ui.buildToolbar`) — so it is selectable on
  PC (number key 3 / clicking the button) AND mobile (tapping the same tool button; no separate
  mobile UI). First-person grenade viewmodel (`scene._buildViewModel('grenade')`).
- **Throw / aim**: LEFT-CLICK on PC (the primary/fire action) / the existing fire button on mobile,
  while the grenade is selected. `tryFire()` routes to `tryGrenade()` when `state.tool === 'grenade'`.
  The client sends ONLY the camera-forward aim direction (`C2S.GRENADE {dx,dy,dz}`) — never a hit
  point. The HOST raycasts that aim through its own world (reusing the rifle's `raycastShot`) and
  the grenade explodes INSTANTLY at the first hit (no arc / travel / fuse). **NO COOLDOWN** — balanced
  by risk. It does NOT auto-repeat on a held click (only the rifle does), so one throw per press.
- **Base damage** = `rules.grenade.baseDamage` = **0.45** (a FRACTION of full health = 45%). The
  referee scales it by `startHealth` → HP (0.45 × 100 = 45), then by the **same prop-size multiplier
  the rifle uses** (`multiplierForDisguise`) so a tiny burger prop takes proportionally more and dies.
- **Radius + falloff** (authored as **1 + 2**, NOT an outer radius of 3 — VRmike's explicit ask):
  `fullDamageRadius` = 1 m of MAX damage, `falloffDistance` = 2 m ADDED past it, so total range =
  1 + 2 = 3 m (derived by `grenadeOuterRadius`, never stored). Distance `d` from the blast centre:
  d ≤ 1 → full; 1 < d < 3 → `base×sizeMult×(1-(d-1)/2)` (d=2 → half, d=2.99 → ~0); d ≥ 3 → 0.
  Pure `grenadeFalloff(d, cfg)` in `shared/damage.js`. Spherical (3D) distance.
- **Backfire** (the core risk): the blast ALSO damages the THROWING hunter, but ONLY through
  non-player DECOY props — the same "could be a player but isn't" objects the rifle backfires on
  (a disguisable, non-architecture prop instance, `prop.disguisable !== false && !isArchEntry`).
  FLAT `baseDamage × falloff` per decoy, **NO size multiplier** (mirrors the rifle's flat wrong-guess
  penalty), so ~3 direct decoy hits (0.45 × 3 = 1.35 of full HP) are lethal — the falloff math
  produces "~3" without hardcoding it. NO friendly fire (other hunters are never targeted) and NO
  direct self-damage (the blast reaches the thrower ONLY through decoys).
- **Redemption rule** (ordering is LOAD-BEARING, host-authoritative): if the blast KILLS ≥1 prop
  PLAYER, the thrower is restored to FULL HP even if the backfire would have been lethal. Resolution
  order in `_resolveGrenadeBlast`: (1) compute ALL prop-player damage AND the total backfire without
  applying anything; (2) apply the prop-player damage, note if any prop player died; (3) if a prop
  died → thrower to full, backfire forgiven (never applied); else → apply the backfire (may kill the
  hunter). The backfire can NEVER kill the hunter before the prop-kill check runs.

## FLING — loose props fly (2026-07-18, VRmike)

Grenades now FLING loose dynamic props caught in the blast, with force LINEAR to the damage dealt
(more damage = more fling), host-authoritative, on the existing Rapier bodies.
- **Where:** `_resolveGrenadeBlast` step (4), AFTER damage/redemption, BEFORE the broadcast. Iterates
  `this.props`, and for each in range (`d < outer`, `grenadeFalloff(d) > 0`) calls
  `physics.applyBlastImpulse(prop.id, center, g.flingSpeed * f)`. Speed = `flingSpeed × falloff`, so
  it's LINEAR to the same falloff the damage uses — close hit = big fling, edge = a nudge.
- **Config:** `rules.grenade.flingSpeed` (**32** m/s target speed at full damage — was 8, scaled ×4 on
  2026-07-19 as a VRmike balance tweak, whole curve up, linear-with-damage shape unchanged; **0 disables**).
  Added to `resolveGrenadeCfg` (`shared/damage.js`). Hot-tunable; rides the B3-tuned radii for free
  (the fling loop reads the same `outer`/`grenadeFalloff` as the damage loops — no new balance math).
- **Physics primitive:** NEW `physics.applyBlastImpulse(propId, center, speed)` (`shared/physics.js`,
  right after `applyShotImpulse`, self-contained — the shot path is byte-identical). Finds the dynamic
  body by id, derives an OUTWARD direction from the body's live `translation()` vs `center` (dead-centre
  → straight up), adds a **0.35 upward bias** (props pop-and-tumble, not skid flat), MASS-SCALES the
  impulse (`speed × mass` — a heavy table and a light burger both react without launching the tiny
  props, exactly like the shot kick), wakes the body first, `applyImpulse`. Fail-silent: no-op for a
  missing/non-dynamic body (architecture / capped-static / disguised PLAYERS — they're kinematic and
  have no prop body), non-positive speed, guest predictor, or API gap; never throws.
- **Netcode:** ZERO new. The host shoves its authoritative Rapier body; the motion reaches everyone
  through the existing host→peers awake-prop snapshot stream (`awakeProps` → `broadcastSnapshot.props`),
  and the blindfold data-gate still applies as-is.
- **Scope (deliberate):** disguised **players** are immune (kinematic, script-controlled — no dynamic
  prop body for the sim to push), so a player hiding as a crate is NOT flung — only loose world objects
  fly. Matches the request ("existing Rapier physics"). Player-knockback would be a new mechanism —
  DEFERRED unless asked.
- **Guard:** `check-grenade.mjs` §I — a MOCK physics records `applyBlastImpulse` calls: props inside
  fly (CENTER + MID), a prop past `outer` does NOT, speed = `flingSpeed × falloff` (full at centre,
  half at mid — linear), closer > edge, every call passes the centre; `flingSpeed=0` disables; no
  physics → still damages + skips fling (no throw); plus source asserts for the physics primitive
  (outward/mass-scaled/wake/guarded) + the offline-safe host gating.

## SELF-KILL FLING — the blast still throws everything even when it kills the thrower (2026-07-19, VRmike)

Symptom: when the hunter's OWN grenade killed the hunter (backfire self-kill), nothing went flying —
the fling was cancelled. Desired: everything still bounces (it's funnier after a self-kill).

Root cause (an ORDERING/lifecycle bug, not an early-return): `_resolveGrenadeBlast` DID apply the
fling impulses, but they were applied AFTER the backfire self-damage. A self-kill = the last hunter
dies → `checkRoundOver` → `endRound(PROP)` → `setPhase(ENDING)`. The physics world only STEPS during
HIDING/HUNTING (`tick` gated `integrate`), so the instant the round flipped to ENDING the sim froze:
the impulse was applied to the Rapier bodies but never integrated into motion → props stuck mid-blast.

Fix (two parts, `shared/referee.js`):
1. **Order:** the fling loop is now step (2) of `_resolveGrenadeBlast`, applied BEFORE any prop/backfire
   damage (steps 3–4). Death never cancels the shove the blast already earned. (Defensive — with part 2
   the physics runs regardless of order, but this makes intent explicit + immune to a future early-return.)
2. **Keep stepping through ENDING:** `tick()` now also calls `integrate(dt)` during `PHASE.ENDING`, and
   `integrate` FREEZES all player movement during ENDING (`frozen = phase===ENDING || (hunter && HIDING)`).
   So the flung props actually fly + settle on the results screen, `awakeProps()` keeps broadcasting them
   (broadcastSnapshot already ran during ENDING), and nobody roams the end screen. `_sweepSilentPlayers`
   is NOT run during ENDING (nobody's dropped for going quiet on the results screen). The ENDING→next-round
   timer transition is unchanged.

Guard: `tools/check-grenade.mjs` §J — a lone hunter self-kills on a decoy pile (no prop-kill redemption);
assert the thrower dies, the round flips to ENDING, and EVERY loose prop in range still received a
positive fling impulse. Plus §I source asserts: the fling loop precedes the backfire self-damage; `tick`
steps physics during ENDING; `integrate` freezes players during ENDING. Live-confirm the props actually
tumble on both screens after a self-kill (headless can't render the motion).

## NEAREST-SURFACE DISTANCE — measure to the surface, not the pivot (2026-07-20, VRmike)

Symptom (playtest bug, screenshots): a grenade "3 m from a fridge" was treated as "3 m from the
fridge's CENTRE," so a big prop PLAYER (fridge/table) shrugged off blasts that were visibly touching
its side — you had to hit the pivot. Fix: measure damage/fling distance from the nearest point on the
target's SURFACE. The blast **radius and falloff curve are UNCHANGED** — only where `d` is measured FROM.

Side effect (intended, VRmike): big props take noticeably MORE grenade damage/fling now (the surface
is closer than the centre, so falloff scales UP). If fridges feel *too* fragile, that's a follow-up
balance knob (radii / baseDamage in rules.json), NOT a bug in this change.

Preference order for `d` (in `referee._blastDist(center, physDist, pos, entry)`):
1. **Live Rapier collider** — the exact closest point on the object's real (possibly hull/complex)
   shape via `world.projectPoint(center, solid=true, …predicate)` filtered to that ONE collider's
   handle. `solid=true` → a `center` INSIDE the shell projects to itself ⇒ distance **0** (full
   damage, never negative / divide-by-zero). Two `PhysicsWorld` methods:
   `nearestPropSurfaceDistance(propId, center)` (dynamic body OR capped-static obstacle — both in
   `_propHandleToId`) and `nearestPlayerSurfaceDistance(playerId, center)` (a disguised player's
   MOVEMENT collider — the true prop shape from `setPlayerCollider`, so a fridge-player measures from
   the fridge's side exactly like a real fridge). Both return `null` if the collider isn't queryable.
2. **Bounding-box fallback** — `damage.boxBlastDistance(center, pos, entry)`: nearest point on an
   axis-aligned box carrying the target's `halfExtentsFor` half-extents, seated with its BASE at `pos`
   (centre = base + hy). Used offline (the guard has no Rapier) or when a target has no live collider.
   Cruder than the real collider but **NEVER worse than the old centre distance**. 0 when inside.
3. **Centre distance** (`dist3`) ONLY when the target has no known size (undisguised / unknown type) —
   the one case with no box to measure. NEVER a silent centre fallback for a sized target.

`_blastDist` clamps `physDist` to `>= 0`. All three blast loops (prop-PLAYER damage, decoy BACKFIRE,
and FLING magnitude) now feed surface distance into the SAME `grenadeFalloff`. FLING **direction** is
still derived inside `applyBlastImpulse` from the body position vs `center` (push away from the blast),
so the measuring point and the shove direction are decided separately — big props fly the right way.

Guards:
- `tools/check-grenade.mjs` §K (offline, mock physics + box fallback): a table player whose PIVOT is
  beyond `outer` but whose SIDE the blast touches now takes real damage (`surface = base×size-mult×
  surface-falloff`); near-surface > far-surface; small props' measurement point moves in by only their
  (small) half-extent while big props move a lot; the live-collider distance is PREFERRED over
  box/centre; dist 0 (and a defensive negative) ⇒ FULL damage; physics `null` ⇒ box fallback;
  undisguised ⇒ centre. §D/§I were updated to assert surface-based (box) distances, derived from the
  same `boxBlastDistance` (relationship, not frozen centre numbers).
- `tools/check-grenade-surface.mjs` (NEW, real Rapier, SKIPs+exit 3 if the WASM package is absent):
  stands up a real `PhysicsWorld` and proves the query itself — a 2.4 m table's surface distance from a
  blast 3 m off its pivot is ~1.8 m (= centre − half-width), 0 inside, monotonic with distance, `null`
  for an unknown id; and a table-DISGUISED player is measured from the box side identically. Exits via
  `process.exitCode` (not `process.exit`) so Rapier's WASM teardown can't abort a clean pass on Windows.

## Netcode (host-authoritative, matches the rifle)

`C2S.GRENADE {dx,dy,dz}` → `referee.applyGrenade`:
1. reject unless a LIVING HUNTER in HUNTING (frozen/blind in HIDING, like the rifle/finder);
2. normalise the aim (fall back to yaw/pitch); raycast from the eye through the world to find the
   blast centre (the first hit; on a clean miss / 2D fallback it's the aim-ray end — nothing to hit);
3. `_resolveGrenadeBlast(hunter, center)` does all damage + the redemption rule, then broadcasts
   `S2C.EVENT kind:'grenade' {by,x,y,z,hits,backfire,redeemed}` to everyone (explosion flash +
   thrower feedback). Per-target damage/deaths still ride the normal `kind:'hurt'`/`kind:'eliminated'`
   events + the health snapshot (reuses `_damagePlayer`, incl. its existing prop-kill refill).

The host recomputes the blast centre itself, so a hacked client can aim anywhere (legal) but can
never move the blast to fake a kill or dodge the backfire (proven in the check with a stubbed
raycast + bogus client hit coords that are ignored).

## Client feedback (reuses existing paths)

- 3D explosion at the blast centre (`scene.spawnExplosion` — a bright core + expanding shell, faded
  by `updateEffects` like the rifle tracer, radius from `rules.grenade` = 1+2).
- Local screen flash for a nearby blast (`scene.blastFlashAt` → intensity by camera distance →
  `ui.flashScreen`, a lazily-created `.blast-flash` overlay that fades). Distant blasts don't flash.
- Thrower feed line: "Grenade kill — redeemed to full health!" or "Grenade backfire off decoys! −X%".

## Files

- `shared/config/rules.json` — `grenade` block (`baseDamage` 0.45, `fullDamageRadius` 1,
  `falloffDistance` 2), all hot-tunable, authored as 1+2.
- `shared/damage.js` — `resolveGrenadeCfg`, `grenadeOuterRadius`, `grenadeFalloff`, `boxBlastDistance`
  (pure; shared by referee + guard).
- `shared/physics.js` — `nearestPropSurfaceDistance` / `nearestPlayerSurfaceDistance` (+ the shared
  `_nearestSurfaceDistance` projectPoint helper) for the live-collider surface distance.
- `shared/referee.js` — `_blastDist` (surface-distance preference: live collider → box → centre), wired
  into all three blast loops.
- `tools/check-grenade-surface.mjs` (new) — real-Rapier live guard for the surface-distance query.
- `shared/protocol.js` — `C2S.GRENADE` + `S2C.EVENT kind:'grenade'` doc.
- `shared/referee.js` — `applyGrenade` (host raycast) + `_resolveGrenadeBlast` (redemption ordering
  + backfire) + `_propBlastPos` + `dist3` helper; `C2S.GRENADE` case. (rifle/finder/taunt UNCHANGED.)
- `js/main.js` — `HUNTER_TOOLS` grenade entry, `tryGrenade`, grenade routing in `tryFire`,
  `case 'grenade'` event handler, hunter banner text.
- `js/scene.js` — `spawnExplosion`, `blastFlashAt`, grenade `_buildViewModel` branch, blast update in
  `updateEffects`, `_blasts` reset in `buildWorld`.
- `js/ui.js` — `flashScreen`; controls-help text (PC "1/2/3", touch tool buttons + ACTION).
- `css/style.css` — `.blast-flash` overlay.
- `tools/check-grenade.mjs` (new).

## Guard: tools/check-grenade.mjs

Drives the REAL referee (`_resolveGrenadeBlast` / `applyGrenade` with a stubbed raycast, no Rapier):
config knobs exist + authored 1+2; falloff full@1 / half@2 / ~0@2.99 / 0@3+; prop-player damage =
base × size-mult × falloff (tiny > plain > big); backfire = decoys only, FLAT base × falloff (burger
decoy == table decoy despite different size mults; architecture / non-disguisable never backfire); NO
friendly fire (another hunter untouched) + NO direct self-damage (no decoys → thrower unhurt); the
redemption ordering (kill → full HP even vs lethal backfire; no kill → lethal backfire kills); ~3
direct decoy hits = lethal (2 don't) without hardcoding; host recomputes the blast from aim (ignores
a client hit point); validation (prop / dead / wrong phase rejected); plus client source assertions.

## OWED — live pass (headless can't do render/peers/audio)

Throw at a CROWD (props die, explosion + screen flash, thrower survives even if standing in decoys
= redeemed to full); throw at a LONE DECOY PILE (backfire mounts, ~3 direct decoy hits kill the
thrower, no redemption); confirm the size multiplier makes a tiny burger prop die where a big table
prop soaks it; confirm the redemption HEAL to full happens on BOTH mobile and PC; confirm the grenade
is selectable + throwable on mobile via the tool button + fire button.

## Tuning (VRmike)

`rules.grenade.baseDamage` / `fullDamageRadius` / `falloffDistance` — one-line changes, no rebuild
(host + client both read them live). Authored as 1 + 2 so the two radius knobs edit independently.
