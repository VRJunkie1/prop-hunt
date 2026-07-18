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
- `shared/damage.js` — `resolveGrenadeCfg`, `grenadeOuterRadius`, `grenadeFalloff` (pure; shared by
  referee + guard).
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
